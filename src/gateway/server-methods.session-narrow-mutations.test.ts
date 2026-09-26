import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import * as chat from "./server-methods/chat-send-external-entry.js";
import { createActiveRun } from "./server-methods/chat.abort.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { sessionMessagingHandlers } from "./server-methods/sessions-messaging.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { resolveSessionSharingTarget } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const key = "agent:main:narrow-mutation";
const scope = { agentId: "main", sessionKey: key };

describe("invocation-owned session mutations", () => {
  it.each([
    { owner: "connection", broad: false, rebind: false },
    { owner: "device", broad: false, rebind: false },
    { owner: "ownerless", broad: false, rebind: false },
    { owner: "connection", broad: false, rebind: true },
    { owner: "device", broad: true, rebind: false },
  ] as const)(
    "sessions.abort retains its invocation scope for a $owner foreign run (broad=$broad, rebind=$rebind)",
    async ({ owner, broad, rebind }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("write", "alias-stop-owner");
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
        const cfg = rolePolicyConfig();
        const foreignKey = "agent:main:foreign-stop";
        await upsertSessionEntryCore(scope, {
          sessionId: "own-incarnation",
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        });
        await upsertSessionEntryCore(
          { ...scope, sessionKey: foreignKey },
          {
            sessionId: "foreign-incarnation",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "another-person" },
          },
        );
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        const foreign = createActiveRun(foreignKey, {
          agentId: "main",
          sessionId: "foreign-incarnation",
          ...(owner === "ownerless"
            ? {}
            : {
                owner:
                  owner === "connection" ? { connId: client.connId } : { deviceId: "alias-device" },
              }),
        });
        const original = createActiveRun(key, {
          agentId: "main",
          sessionId: "own-incarnation",
          owner: { connId: client.connId },
        });
        context.chatAbortControllers.set("selected", rebind ? original : foreign);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const respond = vi.fn();
        const before = [...context.dedupe];
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: "alias-foreign",
            method: "sessions.abort",
            params: { key, runId: "selected" },
          },
          context,
          client,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: {
            "sessions.abort": async (options) => {
              expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
                broad ? undefined : "operator.sessions.write",
              );
              entered.resolve();
              await release.promise;
              await sessionAbortHandlers["sessions.abort"]!(options);
            },
          },
        });
        try {
          await Promise.race([entered.promise, request]);
          expect(respond).not.toHaveBeenCalled();
          if (rebind) {
            context.chatAbortControllers.set("selected", foreign);
          }
        } finally {
          release.resolve();
          await request;
        }
        expect(foreign.controller.signal.aborted).toBe(broad);
        expect(original.controller.signal.aborted).toBe(false);
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(broad);
        if (!broad) {
          expect([...context.dedupe]).toEqual(before);
          expect(context.chatAbortControllers.get("selected")).toBe(foreign);
          expect(context.chatQueuedTurns.size).toBe(0);
        }
      });
    },
  );

  it.each(["sessions.send", "sessions.create"] as const)(
    "%s rejects absent-target routing drift before creation",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const client = roleClient("view", "absent-route-owner");
        client.connect.scopes = ["operator.sessions.write"];
        const originalStore = state.path("original", "sessions.json");
        const nextStore = state.path("replacement", "sessions.json");
        let cfg = { ...rolePolicyConfig(), session: { store: originalStore } };
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const dispatched = vi.spyOn(chat, "handleDirectExternalChatSend");
        const owner =
          method === "sessions.send"
            ? sessionMessagingHandlers[method]!
            : sessionCreateHandlers[method]!;
        const respond = vi.fn();
        const request = handleGatewayRequest({
          req: { type: "req", id: method, method, params: { key, message: "first turn" } },
          client,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          respond,
          isWebchatConnect: () => false,
          extraHandlers: {
            [method]: async (options) => {
              entered.resolve();
              await release.promise;
              await owner(options);
            },
          },
        });
        try {
          await Promise.race([entered.promise, request]);
          expect(respond).not.toHaveBeenCalled();
          cfg = { ...cfg, session: { store: nextStore } };
        } finally {
          release.resolve();
          await request;
        }
        expect(respond.mock.calls[0]?.[0]).toBe(false);
        expect(dispatched).not.toHaveBeenCalled();
        for (const storePath of [originalStore, nextStore]) {
          expect(loadSessionEntry({ ...scope, storePath })).toBeUndefined();
        }
      });
    },
  );

  it.each(
    (["active", "queued", "pending-chat", "agent"] as const).flatMap((kind) =>
      (["chat.abort", "sessions.abort"] as const).map((method) => ({ kind, method })),
    ),
  )(
    "$method narrow single and bulk Stop match the original $kind producer incarnation",
    async ({ kind, method }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "exact-stop-owner");
        client.connId = "exact-stop-connection";
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        await upsertSessionEntryCore(scope, {
          sessionId: "current-incarnation",
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        });
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
              agentId: "main",
              sessionId:
                mismatch === "incarnation"
                  ? "previous-incarnation"
                  : mismatch === "unbound" || mismatch === "missing-target"
                    ? ""
                    : "current-incarnation",
              owner: { connId: client.connId },
            });
            if (kind === "active") {
              context.chatAbortControllers.set(runId, run);
            } else if (kind === "queued") {
              context.chatQueuedTurns.set(runId, run);
            } else {
              context.dedupe.set(`${kind}:${runId}`, {
                ts: Date.now(),
                ok: true,
                payload: {
                  runId,
                  status: "accepted",
                  agentId: "main",
                  ownerConnId: client.connId,
                  ...(mismatch === "unbound" || mismatch === "missing-target"
                    ? {}
                    : { sessionKey: run.sessionKey, sessionId: run.sessionId }),
                },
              });
            }
            const before = [...context.dedupe];
            const respond = vi.fn();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: runId,
                method,
                params: {
                  ...(method === "chat.abort" ? { sessionKey: requestKey } : { key: requestKey }),
                  ...(explicit ? { runId } : {}),
                },
              },
              client,
              context,
              respond,
              isWebchatConnect: () => false,
              extraHandlers: {
                "chat.abort": handleChatAbortRequest,
                "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
              },
            });
            const allowed = mismatch === "none";
            if (kind === "active" || kind === "queued") {
              expect(run.controller.signal.aborted).toBe(allowed);
            } else if (!allowed) {
              expect([...context.dedupe]).toEqual(before);
            }
            if (allowed) {
              expect(respond.mock.calls[0]?.[1]).toMatchObject(
                method === "chat.abort"
                  ? { aborted: true, runIds: [runId] }
                  : { abortedRunId: runId, status: "aborted" },
              );
            }
            expect(respond).toHaveBeenCalledOnce();
          }
        }
      });
    },
  );

  it.each(
    (["active", "queued"] as const).flatMap((kind) =>
      (["chat.abort", "sessions.abort"] as const).map((method) => ({ kind, method })),
    ),
  )(
    "$method does not adopt a reentrant $kind producer replacement during narrow Stop",
    async ({ kind, method }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "reentrant-stop-owner");
        client.connId = "reentrant-stop";
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        await upsertSessionEntryCore(scope, {
          sessionId: "original",
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        });
        for (const changed of ["registration", "key", "sessionId", "agentId"] as const) {
          const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
          const runs = kind === "active" ? context.chatAbortControllers : context.chatQueuedTurns;
          const target = {
            agentId: "main",
            sessionId: "original",
            owner: { connId: client.connId },
          };
          const first = createActiveRun(key, target);
          const second = createActiveRun(key, target);
          const replacement = createActiveRun(key, target);
          runs.set("first", first);
          runs.set("second", second);
          first.controller.signal.addEventListener(
            "abort",
            () => {
              if (changed === "registration") {
                runs.set("second", replacement);
              } else if (changed === "key") {
                second.sessionKey = "agent:main:other";
              } else {
                second[changed] = "replacement";
              }
            },
            { once: true },
          );
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: changed,
              method,
              params: method === "chat.abort" ? { sessionKey: key } : { key },
            },
            client,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: {
              "chat.abort": handleChatAbortRequest,
              "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
            },
          });
          expect(first.controller.signal.aborted).toBe(true);
          expect(second.controller.signal.aborted).toBe(false);
          expect(replacement.controller.signal.aborted).toBe(false);
          expect(respond.mock.calls[0]?.[1]).toMatchObject(
            method === "chat.abort"
              ? { aborted: true, runIds: ["first"] }
              : { abortedRunId: "first", status: "aborted" },
          );
        }
      });
    },
  );

  it.each(["key", "incarnation"] as const)(
    "does not borrow a different owned run %s for narrow Stop",
    async (changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "stop-owner");
        client.connId = "same-connection";
        const cfg = rolePolicyConfig();
        await upsertSessionEntryCore(scope, {
          sessionId: "own-row",
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        });
        for (const grant of ["operator.sessions.write", "operator.write"]) {
          client.connect.scopes = [grant];
          const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
          const run = createActiveRun(changed === "key" ? "agent:main:other" : key, {
            agentId: "main",
            sessionId: changed === "key" ? "own-row" : "prior-incarnation",
            owner: { connId: client.connId },
          });
          context.chatAbortControllers.set("different-run", run);
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: grant,
              method: "chat.abort",
              params: { sessionKey: key, runId: "different-run" },
            },
            client,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: { "chat.abort": handleChatAbortRequest },
          });
          expect(run.controller.signal.aborted).toBe(grant === "operator.write");
          expect(respond.mock.calls[0]?.[0]).toBe(grant === "operator.write");
        }
      });
    },
  );

  it.each(["sessions.send", "sessions.create"] as const)(
    "%s keeps its original lease when creation commits before the initial turn",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "initial-turn-owner");
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        const createdKey = "agent:main:main";
        const dispatched = vi.fn();
        const dispatch = vi
          .spyOn(chat, "handleDirectExternalChatSend")
          .mockImplementation(async (options) => {
            readGatewayRequestMutationAuthority(options).assertCurrent();
            options.sessionMutationAuthorization?.assertCurrent();
            const entry = loadSessionEntry({ agentId: "main", sessionKey: createdKey });
            expect(entry?.createdActor).toMatchObject({
              id: client.authenticatedUserProfile!.profileId,
            });
            expect(entry?.sessionId).toBeTruthy();
            dispatched();
            options.respond(true, { status: "queued" });
          });
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: method, method, params: { key: createdKey, message: "hello" } },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: { ...sessionMessagingHandlers, ...sessionCreateHandlers },
        });
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatched).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      });
    },
  );

  it("does not subtract broad reads or specialized approvals from mixed grants", async (test) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const client = roleClient("view", "mixed-grants");
      client.connect.scopes = ["operator.read", "operator.approvals", "operator.sessions.write"];
      const owner = roleClient("view", "mixed-owner");
      const cfg = rolePolicyConfig();
      expectDefined(cfg.gateway?.roles?.definitions.view, "mixed-grant role").scopes.push(
        "operator.approvals",
      );
      await upsertSessionEntryCore(scope, {
        sessionId: "mixed-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: owner.authenticatedUserProfile!.profileId,
        },
      });
      const target = resolveSessionSharingTarget({ cfg, ...scope })!;
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
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: method, method, params },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          methodRegistry: createGatewayMethodRegistry([
            {
              name: method,
              handler,
              owner: { kind: "core", area: "gateway" },
              scope: requiredScope,
            },
          ]),
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(true, { allowed: true });
      }
    });
  });

  it.each(["sessions.send", "sessions.steer"] as const)(
    "%s forwards the original source and exact target across the dispatch await",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "send-owner");
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        for (const changed of ["none", "source", "generation"] as const) {
          const entry = {
            sessionId: "original",
            lifecycleRevision: "original",
            updatedAt: 1,
            visibility: "draft" as const,
            createdActor: {
              type: "human" as const,
              source: "profile" as const,
              id: client.authenticatedUserProfile!.profileId,
            },
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
          const respond = vi.fn();
          const request = handleGatewayRequest({
            req: { type: "req", id: changed, method, params: { key, message: "hello" } },
            client,
            context,
            respond,
            hasCurrentClientAuthority: () => current,
            isWebchatConnect: () => false,
            extraHandlers: sessionMessagingHandlers,
          });
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
    },
  );

  it.each(["source", "generation", "missing-single", "missing-batch"] as const)(
    "session mutation preserves the original %s fence",
    async (changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "batch-owner");
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        const entry = {
          sessionId: "original",
          lifecycleRevision: "original",
          updatedAt: 1,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: client.authenticatedUserProfile!.profileId,
          },
        };
        const missing = changed.startsWith("missing");
        const method = changed === "missing-single" ? "sessions.patch" : "sessions.patchMany";
        if (!missing) {
          await upsertSessionEntryCore(scope, entry);
        }
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        let current = true;
        const respond = vi.fn();
        const handler: GatewayRequestHandler = async (options) => {
          entered.resolve();
          await resume.promise;
          await sessionMutationHandlers[method]!(options);
        };
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: changed,
            method,
            params:
              method === "sessions.patch"
                ? { key, label: "Unowned claim" }
                : {
                    targets: [{ key }],
                    patch: missing ? { label: "Unowned claim" } : { unread: true },
                  },
          },
          client,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          respond,
          hasCurrentClientAuthority: () => current,
          isWebchatConnect: () => false,
          extraHandlers: { [method]: handler },
        });
        try {
          await Promise.race([entered.promise, request]);
          if (missing) {
            resume.resolve();
            await request;
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
          expect(respond).not.toHaveBeenCalled();
          if (changed === "source") {
            current = false;
          } else {
            await upsertSessionEntryCore(scope, { ...entry, lifecycleRevision: "replacement" });
          }
        } finally {
          resume.resolve();
          await request;
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
