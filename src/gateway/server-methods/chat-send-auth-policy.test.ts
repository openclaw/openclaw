import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../auto-reply/reply/queue/state.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { publishOperatorRoleConfigChange } from "../operator-role-policy.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { disconnectDisallowedGatewayPolicyClients } from "../server/ws-origin-policy.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it.each([true, false])(
  "retains queued chat input across other grants (verified identity: %s)",
  async (verified) => {
    const fixture = await createFixture();
    const identity = "retained@example.test";
    const profile = ensureProfileForEmail(identity);
    let current: OpenClawConfig = {
      ...fixture.context.getRuntimeConfig(),
      gateway: { auth: { identityScopes: { [identity]: ["operator.read", "operator.write"] } } },
    };
    setRuntimeConfigSnapshot(current);
    fixture.context.getRuntimeConfig = () => current;
    fixture.context.getCommittedRuntimeConfig = () => current;
    fixture.context.resolveGatewayContext = () => fixture.context;
    const close = vi.fn();
    const client = {
      ...createOperatorWsClient({
        scopes: fixture.client.connect.scopes,
        socket: { close },
      }),
      connect: fixture.client.connect,
      authPolicy: captureGatewayAuthPolicy(current, {
        role: "operator",
        verifiedIdentity: verified ? identity : undefined,
      }),
      ...(verified ? { authenticatedUserId: identity } : {}),
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        avatarRevision: "1",
        updatedAt: profile.updatedAt,
      },
    };
    const harness = createDispatchTestHarness({
      buildRequestContext: () => fixture.context,
      extraHandlers: { "chat.send": handleChatSend },
    });
    const publish = (next: typeof current) => {
      current = next;
      setRuntimeConfigSnapshot(current);
      publishOperatorRoleConfigChange(fixture.context);
      disconnectDisallowedGatewayPolicyClients([client], current);
    };
    let completion: Promise<void> | undefined;
    try {
      await harness.dispatcher.dispatch(
        { type: "req", id: "queued-input", method: "chat.send", params: fixture.params },
        client,
      );
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "queued-input", ok: true }),
      );
      await fixture.dispatchedRecorder;
      const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as Parameters<
        typeof dispatchInboundMessage
      >[0];
      const authority = dispatch.replyOptions?.operatorAuthority;
      assert(authority);
      const active = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
      assert(active);
      const run = createQueueTestRun({ prompt: fixture.params.message });
      run.abortSignal = active.controller.signal;
      run.turnAdoptionLifecycle = dispatch.replyOptions?.turnAdoptionLifecycle;
      run.operatorAuthority = authority;
      expect(
        enqueueFollowupRun(
          fixture.scope.sessionKey,
          run,
          createQueueSettings({ mode: "followup" }),
          "none",
          async () => {},
          false,
        ),
      ).toBe(true);
      const detached = createDeferred();
      fixture.context.removeChatRun = () => {
        detached.resolve();
        return undefined;
      };
      completion = fixture.finishDispatch();
      await detached.promise;
      expect(fixture.context.chatQueuedTurns.has(fixture.params.idempotencyKey)).toBe(true);
      const pending = await listSessionPendingInputs(fixture.scope);
      expect(pending.total).toBe(1);
      for (const grant of [["operator.read"], ["operator.admin"], undefined] as const) {
        const next = structuredClone(current);
        const scopes = next.gateway!.auth!.identityScopes!;
        if (grant) {
          scopes["other@example.test"] = [...grant];
        } else {
          delete scopes["other@example.test"];
        }
        publish(next);
        expect(authority.assertCurrent).not.toThrow();
        expect(authority.signal?.aborted).toBe(false);
        expect(client.invalidated).not.toBe(true);
        expect(fixture.context.chatQueuedTurns.has(fixture.params.idempotencyKey)).toBe(true);
        expect(getExistingFollowupQueue(fixture.scope.sessionKey)?.items).toHaveLength(1);
        expect(await listSessionPendingInputs(fixture.scope)).toEqual(pending);
      }
      const narrowed = structuredClone(current);
      narrowed.gateway!.auth!.identityScopes![identity] = ["operator.read"];
      const granted = current;
      publish(narrowed);
      publish(granted);
      if (verified) {
        expect(authority.signal?.aborted).toBe(true);
        expect(authority.assertCurrent).toThrow(/authority is no longer active/);
        expect(client.invalidated).toBe(true);
        expect(active.controller.signal.aborted).toBe(true);
        expect(getExistingFollowupQueue(fixture.scope.sessionKey)?.items ?? []).toHaveLength(0);
      } else {
        expect(authority.assertCurrent).not.toThrow();
        expect(authority.signal?.aborted).toBe(false);
        publish({ ...current, gateway: { ...current.gateway, allowRealIpFallback: true } });
        expect(client.invalidated).toBe(true);
        expect(close).toHaveBeenCalledWith(4001, "gateway policy changed");
        expect(authority.signal?.aborted).toBe(false);
        expect(authority.assertCurrent).not.toThrow();
        expect(active.controller.signal.aborted).toBe(false);
        expect(fixture.context.chatQueuedTurns.has(fixture.params.idempotencyKey)).toBe(true);
        expect(getExistingFollowupQueue(fixture.scope.sessionKey)?.items).toHaveLength(1);
        expect(await listSessionPendingInputs(fixture.scope)).toEqual(pending);
      }
    } finally {
      clearFollowupQueue(fixture.scope.sessionKey);
      await completion;
      await fixture.cleanup();
    }
  },
);
