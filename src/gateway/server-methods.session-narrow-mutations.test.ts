import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { abortSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import {
  rpcSourceTesting,
  setRpcSourceIdentityForTest,
} from "../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { startExactAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import * as chat from "./server-methods/chat-send-external-entry.js";
import { createActiveRun } from "./server-methods/chat.abort.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { sessionMessagingHandlers } from "./server-methods/sessions-messaging.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { resolveSessionSharingTargetAsync } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const key = "agent:main:narrow-mutation";
const scope = { agentId: "main", sessionKey: key };

function ownedEntry(client: ReturnType<typeof roleClient>, sessionId: string) {
  return {
    sessionId,
    updatedAt: 1,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: client.authenticatedUserProfile!.profileId,
    },
  };
}

const withState = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);

function ownerFixture(name: string, role: Parameters<typeof roleClient>[0] = "view") {
  const client = roleClient(role, name);
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  return {
    client,
    cfg,
    context,
    run: (sessionId: string, sessionKey = key) =>
      createActiveRun(sessionKey, { agentId: "main", sessionId, owner: { connId: client.connId } }),
  };
}

function pausedHandler(
  handler: GatewayRequestHandler,
  before?: (options: Parameters<GatewayRequestHandler>[0]) => void,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    handler: (async (options) => {
      before?.(options);
      entered.resolve();
      await release.promise;
      await handler(options);
    }) satisfies GatewayRequestHandler,
    async during(request: Promise<void>, change: () => void | Promise<void>) {
      try {
        await Promise.race([entered.promise, request]);
        await change();
      } finally {
        release.resolve();
        await request;
      }
    },
  };
}

function expectAborted(respond: ReturnType<typeof vi.fn>, method: string, runId: string) {
  expect(respond.mock.calls[0]?.[1]).toMatchObject(
    method === "chat.abort"
      ? { aborted: true, runIds: [runId] }
      : { abortedRunId: runId, status: "aborted" },
  );
}

const stopHandlers = {
  "chat.abort": handleChatAbortRequest,
  "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
};

describe("invocation-owned session mutations", () => {
  it.each([
    { owner: "connection", broad: false, rebind: true },
    { owner: "device", broad: true, rebind: false },
  ] as const)(
    "sessions.abort retains its invocation scope for a $owner foreign run (broad=$broad, rebind=$rebind)",
    async ({ owner, broad, rebind }) => {
      await withState(async () => {
        const { client, context, run } = ownerFixture("alias-stop-owner", "write");
        client.connId = "alias-stop-connection";
        client.connect.device = {
          id: "alias-device",
          publicKey: "test",
          signature: "test",
          signedAt: 1,
          nonce: "test",
        };
        client.connect.scopes = broad
          ? ["operator.write", "operator.sessions.write"]
          : ["operator.sessions.write"];

        const foreignKey = "agent:main:foreign-stop";
        await upsertSessionEntryCore(scope, ownedEntry(client, "own-incarnation"));
        await upsertSessionEntryCore(
          { ...scope, sessionKey: foreignKey },
          {
            sessionId: "foreign-incarnation",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "another-person" },
          },
        );
        const foreign = createActiveRun(foreignKey, {
          agentId: "main",
          sessionId: "foreign-incarnation",
          owner: owner === "connection" ? { connId: client.connId } : { deviceId: "alias-device" },
        });
        const original = run("own-incarnation");
        rpcSourceTesting.set("selected", rebind ? original : foreign);
        const paused = pausedHandler(sessionAbortHandlers["sessions.abort"]!, (options) =>
          expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
            broad ? undefined : "operator.sessions.write",
          ),
        );
        const before = [...context.dedupe];
        const { request, respond } = startExactAuthorizationRequest(
          "sessions.abort",
          { key, runId: "selected" },
          { client, context, extraHandlers: { "sessions.abort": paused.handler } },
          "alias-foreign",
        );
        await paused.during(request, () => {
          expect(respond).not.toHaveBeenCalled();
          if (rebind) {
            rpcSourceTesting.set("selected", foreign);
          }
        });
        expect([foreign, original].map((entry) => entry.input.abortSignal.aborted)).toEqual([
          broad,
          false,
        ]);
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(broad);
        if (!broad) {
          expect([...context.dedupe]).toEqual(before);
          expect(rpcSourceTesting.get("selected")).toBe(foreign);
          expect(rpcSourceTesting.size).toBe(1);
        }
      });
    },
  );

  it.each([
    { method: "sessions.send", phase: "routing drift" },
    { method: "sessions.send", phase: "committed creation" },
    { method: "sessions.create", phase: "routing drift" },
    { method: "sessions.create", phase: "committed creation" },
  ] as const)("$method preserves creation authority across $phase", async ({ method, phase }) => {
    await withState(async (state) => {
      const client = roleClient("view", "creation-owner");
      client.connect.scopes = ["operator.sessions.write"];
      const originalStore = state.path("original", "sessions.json");
      const nextStore = state.path("replacement", "sessions.json");
      const drift = phase === "routing drift";
      let cfg = drift
        ? { ...rolePolicyConfig(), session: { store: originalStore } }
        : rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const targetKey = drift ? key : "agent:main:main";
      const send = vi.spyOn(chat, "handleDirectExternalChatSend");
      if (!drift) {
        send.mockImplementation(async (options) => {
          readGatewayRequestMutationAuthority(options).assertCurrent();
          options.sessionMutationAuthorization?.assertCurrent();
          const entry = loadSessionEntry({ agentId: "main", sessionKey: targetKey });
          expect(entry?.createdActor).toMatchObject({
            id: client.authenticatedUserProfile!.profileId,
          });
          expect(entry?.sessionId).toBeTruthy();
          options.respond(true, { status: "queued" });
        });
      }
      const handlers = { ...sessionMessagingHandlers, ...sessionCreateHandlers };
      const paused = pausedHandler(handlers[method]!);
      const { request, respond } = startExactAuthorizationRequest(
        method,
        { key: targetKey, message: drift ? "first turn" : "hello" },
        {
          client,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          extraHandlers: drift ? { [method]: paused.handler } : handlers,
        },
      );
      if (drift) {
        await paused.during(request, () => {
          expect(respond).not.toHaveBeenCalled();
          cfg = { ...cfg, session: { store: nextStore } };
        });
      } else {
        await request;
      }
      expect(respond.mock.calls[0]?.[0]).toBe(!drift);
      expect(send).toHaveBeenCalledTimes(drift ? 0 : 1);
      if (drift) {
        for (const storePath of [originalStore, nextStore]) {
          expect(loadSessionEntry({ ...scope, storePath })).toBeUndefined();
        }
      }
    });
  });

  it.each(
    (["active", "queued", "pending-chat", "agent"] as const).flatMap((kind) =>
      (["chat.abort", "sessions.abort"] as const).map((method) => ({ kind, method })),
    ),
  )(
    "$method narrow single and bulk Stop match the original $kind producer incarnation",
    async ({ kind, method }) => {
      await withState(async () => {
        const { client, cfg } = ownerFixture("exact-stop-owner");
        client.connId = "exact-stop-connection";

        await upsertSessionEntryCore(scope, ownedEntry(client, "current-incarnation"));
        for (const explicit of [false, true]) {
          for (const mismatch of [
            "none",
            "key",
            "incarnation",
            "unbound",
            "missing-target",
          ] as const) {
            const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
            const runId = `${kind}-${explicit}-${mismatch}`;
            const requestKey = mismatch === "missing-target" ? "agent:main:missing" : key;
            const run = createActiveRun(mismatch === "key" ? "agent:main:other" : requestKey, {
              // An unbound source cannot publish a native operation with an empty incarnation.
              queued: kind !== "active" || mismatch === "unbound" || mismatch === "missing-target",
              agentId: "main",
              sessionId:
                mismatch === "incarnation"
                  ? "previous-incarnation"
                  : mismatch === "unbound" || mismatch === "missing-target"
                    ? ""
                    : "current-incarnation",
              owner: { connId: client.connId },
            });
            if (kind !== "active" && kind !== "queued") {
              run.adapter.kind = kind === "agent" ? "agent" : "chat-send";
            }
            rpcSourceTesting.set(runId, run);
            const before = [...context.dedupe];
            const { request, respond } = startExactAuthorizationRequest(
              method,
              {
                ...(method === "chat.abort" ? { sessionKey: requestKey } : { key: requestKey }),
                ...(explicit ? { runId } : {}),
              },
              { client, context, extraHandlers: stopHandlers },
              runId,
            );
            await request;
            const allowed = mismatch === "none";
            expect(run.input.abortSignal.aborted).toBe(allowed);
            if (!allowed) {
              expect([...context.dedupe]).toEqual(before);
            }
            if (allowed) {
              expectAborted(respond, method, runId);
            }
            expect(respond).toHaveBeenCalledOnce();
            abortSessionControllerInput(run.input, "Fixture case finished");
            await run.input.settlement.promise;
            rpcSourceTesting.deleteExpected(runId, run);
          }
        }
      });
    },
  );

  it.each(
    (
      [
        { kind: "active", method: "chat.abort" },
        { kind: "queued", method: "chat.abort" },
        { kind: "queued", method: "sessions.abort" },
      ] as const
    ).flatMap((entry) =>
      (["registration", "key", "sessionId", "agentId"] as const).map((changed) => ({
        kind: entry.kind,
        method: entry.method,
        changed,
      })),
    ),
  )(
    "$method does not adopt a reentrant $kind producer $changed during narrow Stop",
    async ({ kind, method, changed }) => {
      await withState(async () => {
        const { client, cfg, context } = ownerFixture("reentrant-stop-owner");
        client.connId = "reentrant-stop";
        await upsertSessionEntryCore(scope, ownedEntry(client, "original"));
        const runs = rpcSourceTesting;
        const session = expectDefined(
          await resolveSessionSharingTargetAsync({ cfg, ...scope }),
          "narrow Stop session target",
        );
        const target = {
          queued: kind === "queued",
          storeScope: session.storePath,
          agentId: "main",
          sessionId: "original",
          owner: { connId: client.connId },
        };
        const first = createActiveRun(key, target);
        // One controller has one active turn; only queued rows retain a second input.
        const second = kind === "queued" ? createActiveRun(key, target) : undefined;
        let replacement: ReturnType<typeof createActiveRun> | undefined;
        runs.set("first", first);
        if (second) {
          runs.set("second", second);
        }
        first.input.abortSignal.addEventListener(
          "abort",
          () => {
            if (kind === "active" || changed === "registration") {
              // Reserve successors after Stop captures the original mailbox inputs.
              replacement = createActiveRun(changed === "key" ? "agent:main:other" : key, {
                ...target,
                sessionId: changed === "sessionId" ? "replacement" : "original",
                agentId: changed === "agentId" ? "replacement" : "main",
              });
              runs.set("second", replacement);
            } else if (changed === "key") {
              setRpcSourceIdentityForTest(expectDefined(second, "queued narrow Stop source"), {
                sessionKey: "agent:main:other",
              });
            } else if (changed === "sessionId") {
              setRpcSourceIdentityForTest(expectDefined(second, "queued narrow Stop source"), {
                sessionId: "replacement",
              });
            } else {
              setRpcSourceIdentityForTest(expectDefined(second, "queued narrow Stop source"), {
                agentId: "replacement",
              });
            }
          },
          { once: true },
        );
        const { request, respond } = startExactAuthorizationRequest(
          method,
          method === "chat.abort" ? { sessionKey: key } : { key },
          { client, context, extraHandlers: stopHandlers },
          changed,
        );
        await request;
        expect(first.input.abortSignal.aborted).toBe(true);
        if (kind === "queued") {
          expect(expectDefined(second, "queued narrow Stop source").input.abortSignal.aborted).toBe(
            false,
          );
        }
        if (kind === "active" || changed === "registration") {
          expect(
            expectDefined(replacement, "reentrant narrow Stop successor").input.abortSignal.aborted,
          ).toBe(false);
        }
        expectAborted(respond, method, "first");
      });
    },
  );

  it.each(["key", "incarnation"] as const)(
    "does not borrow a different owned run %s for narrow Stop",
    async (changed) => {
      await withState(async () => {
        const { client, cfg } = ownerFixture("stop-owner");
        client.connId = "same-connection";
        await upsertSessionEntryCore(scope, ownedEntry(client, "own-row"));
        for (const grant of ["operator.sessions.write", "operator.write"]) {
          client.connect.scopes = [grant];
          const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
          const run = createActiveRun(changed === "key" ? "agent:main:other" : key, {
            agentId: "main",
            sessionId: changed === "key" ? "own-row" : "prior-incarnation",
            owner: { connId: client.connId },
          });
          rpcSourceTesting.set("different-run", run);
          const { request, respond } = startExactAuthorizationRequest(
            "chat.abort",
            { sessionKey: key, runId: "different-run" },
            { client, context, extraHandlers: { "chat.abort": handleChatAbortRequest } },
            grant,
          );
          await request;
          expect(run.input.abortSignal.aborted).toBe(grant === "operator.write");
          expect(respond.mock.calls[0]?.[0]).toBe(grant === "operator.write");
          abortSessionControllerInput(run.input, "Fixture case finished");
          await run.input.settlement.promise;
          rpcSourceTesting.deleteExpected("different-run", run);
        }
      });
    },
  );

  it("does not subtract broad reads or specialized approvals from mixed grants", async (test) => {
    await withState(async () => {
      const client = roleClient("view", "mixed-grants");
      client.connect.scopes = ["operator.read", "operator.approvals", "operator.sessions.write"];
      const owner = roleClient("view", "mixed-owner");
      const cfg = rolePolicyConfig();
      expectDefined(cfg.gateway?.roles?.definitions.view, "mixed-grant role").scopes.push(
        "operator.approvals",
      );
      setRuntimeConfigSnapshot(cfg);
      await upsertSessionEntryCore(scope, {
        ...ownedEntry(owner, "mixed-session"),
        visibility: "shared",
      });
      const target = (await resolveSessionSharingTargetAsync({ cfg, ...scope }))!;
      await addSessionMember(
        { ...scope, storePath: target.storePath },
        {
          identityId: client.authenticatedUserProfile!.profileId,
          addedBy: owner.authenticatedUserProfile!.profileId,
          expectedSessionId: "mixed-session",
        },
      );
      const manager = createTestApprovalManager(test);
      const approval = manager.create(
        { command: "echo allowed", sessionKey: key, agentId: "main" },
        1_000,
        "mixed-approval",
      );
      vi.spyOn(manager, "lookupLocalApprovalId").mockReturnValue({
        kind: "exact",
        id: approval.id,
      });
      vi.spyOn(manager, "getLocalSnapshot").mockReturnValue(approval);
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        execApprovalManager: manager,
      });
      for (const [method, requiredScope, params] of [
        ["progressCard.get", "operator.read", { sessionKey: key }],
        ["exec.approval.resolve", "operator.approvals", { id: approval.id }],
      ] as const) {
        const handler = vi.fn<GatewayRequestHandler>((options) => {
          expect(readGatewayRequestMutationAuthority(options).sessionScope).toBeUndefined();
          options.sessionMutationAuthorization?.assertCurrent();
          options.respond(true, { allowed: true });
        });
        const { request, respond } = startExactAuthorizationRequest(method, params, {
          client,
          context,
          methodRegistry: createGatewayMethodRegistry([
            {
              name: method,
              handler,
              owner: { kind: "core", area: "gateway" },
              scope: requiredScope,
            },
          ]),
        });
        await request;
        expect(handler).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(true, { allowed: true });
      }
    });
  });

  it("sessions.steer forwards the original source and exact target across the dispatch await", async () => {
    const method = "sessions.steer";
    await withState(async () => {
      const { client, context } = ownerFixture("send-owner");
      for (const changed of ["none", "source", "generation"] as const) {
        const entry = {
          ...ownedEntry(client, "original"),
          lifecycleRevision: "original",
          visibility: "draft" as const,
        };
        await upsertSessionEntryCore(scope, entry);
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const effect = vi.fn();
        let current = true;
        const dispatch = vi
          .spyOn(chat, "handleDirectExternalChatSend")
          .mockImplementation(async (options) => {
            const authority = readGatewayRequestMutationAuthority(options);
            entered.resolve();
            await resume.promise;
            authority.assertCurrent();
            options.sessionMutationAuthorization?.assertCurrent();
            effect();
            options.respond(true, { status: "queued" });
          });
        const { request, respond } = startExactAuthorizationRequest(
          method,
          { key, message: "hello" },
          {
            client,
            context,
            hasCurrentClientAuthority: () => current,
            extraHandlers: sessionMessagingHandlers,
          },
          changed,
        );
        const outcome = Promise.allSettled([request]);
        try {
          await Promise.race([entered.promise, request]);
          expect(dispatch).toHaveBeenCalledOnce();
          if (changed === "source") {
            current = false;
          }
          if (changed === "generation") {
            await upsertSessionEntryCore(scope, { ...entry, lifecycleRevision: "replacement" });
          }
        } finally {
          resume.resolve();
          await outcome;
          dispatch.mockRestore();
        }
        expect(effect).toHaveBeenCalledTimes(changed === "none" ? 1 : 0);
        const settled = await outcome;
        if (changed === "source") {
          expect(settled).toMatchObject([
            { status: "rejected", reason: { message: "Gateway requester authority changed" } },
          ]);
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[0]).toBe(changed === "none");
          if (changed === "generation") {
            expect(respond.mock.calls[0]?.[1]).toBeUndefined();
          }
        }
      }
    });
  });

  it.each(["source", "generation", "missing-single", "missing-batch"] as const)(
    "session mutation preserves the original %s fence",
    async (changed) => {
      await withState(async () => {
        const { client, context } = ownerFixture("batch-owner");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const entry = {
          ...ownedEntry(client, "original"),
          lifecycleRevision: "original",
        };
        const missing = changed.startsWith("missing");
        const method = changed === "missing-single" ? "sessions.patch" : "sessions.patchMany";
        if (!missing) {
          await upsertSessionEntryCore(scope, entry);
        }
        let current = true;
        const paused = pausedHandler(sessionMutationHandlers[method]!);
        const { request, respond } = startExactAuthorizationRequest(
          method,
          method === "sessions.patch"
            ? { key, label: "Unowned claim" }
            : {
                targets: [{ key }],
                patch: missing ? { label: "Unowned claim" } : { unread: true },
              },
          {
            client,
            context,
            hasCurrentClientAuthority: () => current,
            extraHandlers: { [method]: paused.handler },
          },
          changed,
        );
        await paused.during(request, async () => {
          if (missing) {
            return;
          }
          expect(respond).not.toHaveBeenCalled();
          if (changed === "source") {
            current = false;
          } else {
            await upsertSessionEntryCore(scope, { ...entry, lifecycleRevision: "replacement" });
          }
        });
        if (missing) {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringContaining("was not found"),
            }),
          );
          expect(loadSessionEntry(scope)).toBeUndefined();
          return;
        }
        expect(loadSessionEntry(scope)?.markedUnreadAt).toBeUndefined();
        expect(respond).toHaveBeenCalledOnce();
        const [ok, payload] = respond.mock.calls[0]!;
        if (ok) {
          expect(payload).toMatchObject({ outcomes: [{ ok: false }] });
        } else {
          expect(payload).toBeUndefined();
        }
      });
    },
  );
});
