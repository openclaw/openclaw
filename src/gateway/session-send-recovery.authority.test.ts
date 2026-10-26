import "./session-send-recovery.delivery.mocks.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { recoverSessionSendDeliveries } from "./session-send-recovery.js";
import { config, delivery, input, sourceSnapshot } from "./session-send-recovery.test-support.js";

const { recoveryDeliveryMocks: io } =
  await import("./session-send-recovery.delivery.mocks.test-support.js");
const dispatch = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  const target = { sessionId: delivery.target.sessionId, updatedAt: 1 };
  const source = {
    sessionId: delivery.source.sessionId,
    lifecycleRevision: delivery.source.lifecycleRevision,
    updatedAt: 1,
  };
  io.discover.mockResolvedValue([{ agentId: "main", storePath: "/fixture/sessions.json" }]);
  io.entries.mockResolvedValue([{ sessionKey: delivery.target.sessionKey, entry: target }]);
  io.load.mockImplementation(async ({ key }: { key: string }) => ({
    agentId: "main",
    canonicalKey: key,
    storePath: "/fixture/sessions.json",
    store: { [key]: key === delivery.source.sessionKey ? source : target },
  }));
  io.report.mockResolvedValue({ ok: true });
  io.withdraw.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

it.each(["operator.sessions.write", "operator.read"])(
  "replays a saved peer under its original %s authority",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const recoveryContext = createDirectChatContext({
        recoveryRuntime: createMockGatewayRecoveryRuntime({ dispatchAgent: dispatch }),
      });
      const fixture = await createOperatorRecoveryFixture({
        stateDir,
        context: recoveryContext,
        profileId: ensureProfileForEmail("peer-recovery@example.test").id,
        config,
        scopes: [scope],
      });
      const original = expectDefined(await fixture.restore(), "original operator authority");
      const operatorSource = captureQueuedOperatorRecoverySource(original.authority);
      original.release();
      const persistedInput = JSON.stringify({
        ...input,
        message: {
          ...input.message,
          __openclaw: { sessionSendDelivery: { ...delivery, operatorSource } },
        },
      });
      const savedInput: SessionPendingInput = JSON.parse(persistedInput);
      io.pending.mockResolvedValue({ items: [savedInput], total: 1 });
      io.source.mockResolvedValue(sourceSnapshot(savedInput));
      let accepted = false;
      dispatch.mockImplementation(async (request, _timeout, options) => {
        options.assertAdmissionCurrent();
        const authority = options.operatorRunAuthority;
        authority.assertCurrent();
        expect(authority.scopes).toEqual([scope]);
        const authorization = authorizeGatewayMethod(
          "agent",
          createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "operator", profileId: authority.profileId },
            operatorRunAuthority: authority,
            scopes: [...authority.scopes],
          }),
          request,
          createGatewayMethodRegistry([]),
          recoveryContext,
        );
        if (authorization.error) {
          unwrapGatewayMethodDispatchResponse("agent", {
            ok: false,
            error: authorization.error,
          });
        }
        accepted = true;
      });

      await recoverSessionSendDeliveries(recoveryContext, new AbortController().signal).settled;

      expect(io.withdraw).not.toHaveBeenCalled();
      expect(accepted).toBe(scope === "operator.sessions.write");
      if (accepted) {
        expect(io.report).not.toHaveBeenCalled();
      } else {
        const report = io.report.mock.calls[0]![1].selectReport(undefined);
        expect(report.details.inputs[0].reason).toBe("permission-denied");
      }
    });
  },
);
