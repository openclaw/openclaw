import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { abortSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import {
  rpcSourceTesting,
  setRpcSourceIdentityForTest,
} from "../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createAgentDedupeLifecycle } from "./agent-turn/agent-dedupe-lifecycle.js";
import { prepareAgentRequestRouting } from "./agent-turn/agent-request-routing.js";
import { createAgentTurnIo } from "./agent-turn/io.js";
import { boardStore } from "./board-store.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  dispatchAuthorizationRequest,
  startExactAuthorizationRequest,
} from "./server-methods.authorization.test-support.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import { createBoardHandlers } from "./server-methods/board.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import * as chat from "./server-methods/chat-send-external-entry.js";
import { normalizeChatSendRequest } from "./server-methods/chat-send-request.js";
import {
  prepareChatSendSession,
  qualifyChatSendSession,
} from "./server-methods/chat-send-session.js";
import { createActiveRun } from "./server-methods/chat.abort.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { sessionMessagingHandlers } from "./server-methods/sessions-messaging.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
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
  const gate = createRequestGate();
  return {
    handler: (async (options) => {
      before?.(options);
      await gate.pause();
      await handler(options);
    }) satisfies GatewayRequestHandler,
    during: gate.during,
  };
}

function expectAborted(respond: ReturnType<typeof vi.fn>, method: string, runId: string) {
  expect(respond.mock.calls[0]?.[1]).toMatchObject(
    method === "chat.abort"
      ? { aborted: true, runIds: [runId] }
      : { abortedRunId: runId, status: "aborted" },
  );
}

function reportContent(text: string) {
  return {
    kind: "plugin" as const,
    pluginKind: "session:report",
    props: { blocks: [{ type: "text", text }] },
  };
}

async function finishRun(runId: string, run: ReturnType<typeof createActiveRun>) {
  abortSessionControllerInput(run.input, "Fixture case finished");
  await run.input.settlement.promise;
  rpcSourceTesting.deleteExpected(runId, run);
}

const stopHandlers = {
  "chat.abort": handleChatAbortRequest,
  "sessions.abort": sessionAbortHandlers["sessions.abort"]!,
};

describe("invocation-owned session mutations", () => {
  it("authorizes component conversations against the parent Lobby rather than a supplied child address", () =>
    withState(async () => {
      const { client, cfg } = ownerFixture("lobby-owner");
      const member = roleClient("view", "lobby-viewer");
      member.connect.scopes = ["operator.sessions.write"];
      const lobbyKey = "agent:main:lobby-11111111-1111-4111-8111-111111111111";
      const target = { agentId: "main", sessionKey: lobbyKey };
      await upsertSessionEntryCore(target, {
        ...ownedEntry(client, "lobby-owner-session"),
        visibility: "shared",
      });
      const saved = await boardStore.putWidget({
        ...target,
        name: "plan",
        content: { kind: "html", html: "<p>Plan</p>" },
      });
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      context.resolveGatewayContext = () => context;
      const extraHandlers = createBoardHandlers(boardStore);
      const params = { ...target, name: "plan", instanceId: saved.widgets[0]!.instanceId };
      const reserve = (requestClient = client) =>
        dispatchAuthorizationRequest("board.widget.conversation", params, {
          client: requestClient,
          context,
          extraHandlers,
        });
      expect((await reserve()).mock.calls[0]).toMatchObject([
        true,
        { key: expect.stringContaining(`${lobbyKey}:component:plan:`) },
      ]);
      expect((await reserve(member)).mock.calls[0]).toMatchObject([
        false,
        undefined,
        { code: "FORBIDDEN" },
      ]);
      client.connect.scopes = ["operator.sessions.read"];
      expect((await reserve()).mock.calls[0]?.[0]).toBe(false);
    }));
  it("lets session-only guests manage their own dashboard while preserving shared VIEW", () =>
    withState(async () => {
      const { client, cfg } = ownerFixture("board-owner");
      const member = roleClient("view", "board-member");
      member.connect.scopes = ["operator.sessions.write"];
      await upsertSessionEntryCore(scope, {
        ...ownedEntry(client, "board-owned"),
        visibility: "shared",
      });
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      context.resolveGatewayContext = () => context;
      const extraHandlers = createBoardHandlers(boardStore);
      const dispatch = (method: string, params: Record<string, unknown>, requestClient = client) =>
        dispatchAuthorizationRequest(
          method,
          { sessionKey: key, ...params },
          {
            client: requestClient,
            context,
            extraHandlers,
          },
        );
      for (const [method, params] of [
        ["board.update", { ops: [{ kind: "tab_create", tabId: "personal", title: "Personal" }] }],
        [
          "board.widget.put",
          {
            name: "summary",
            placement: { tabId: "personal" },
            content: reportContent("My report"),
          },
        ],
      ] as const) {
        const own = (await dispatch(method, params)).mock.calls[0];
        expect(own?.[0], JSON.stringify(own)).toBe(true);
        expect((await dispatch(method, params, member)).mock.calls[0]).toMatchObject([
          false,
          undefined,
          { code: "FORBIDDEN" },
        ]);
      }
      for (const requestClient of [client, member]) {
        requestClient.connect.scopes = ["operator.sessions.read"];
        expect((await dispatch("board.get", {}, requestClient)).mock.calls[0]).toMatchObject([
          true,
          {
            tabs: expect.arrayContaining([
              expect.objectContaining({ tabId: "personal", title: "Personal" }),
            ]),
            widgets: [expect.objectContaining({ name: "summary", pluginKind: "session:report" })],
          },
        ]);
        expect(
          (await dispatch("board.update", { ops: [] }, requestClient)).mock.calls[0]?.[0],
        ).toBe(false);
      }
      await upsertSessionEntryCore(scope, {
        ...ownedEntry(client, "board-owned"),
        visibility: "draft",
      });
      expect((await dispatch("board.get", {}, member)).mock.calls[0]?.[0]).toBe(false);
      await boardStore.putWidget({
        ...scope,
        name: "private",
        content: { kind: "html", html: "<p>owner source</p>" },
      });
      const sourceDenied = await dispatch("board.widget.source", { name: "private" }, member);
      // Match board.get's existence-hiding response for a session this member cannot read.
      expect(sourceDenied.mock.calls[0]).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message: expect.stringContaining("was not found") },
      ]);
      expect(JSON.stringify(sourceDenied.mock.calls)).not.toContain("owner source");
      const ownerSource = await dispatch("board.widget.source", { name: "private" });
      expect(ownerSource.mock.calls[0], JSON.stringify(ownerSource.mock.calls[0])).toMatchObject([
        true,
        { html: "<p>owner source</p>" },
      ]);
      client.connect.scopes = ["operator.sessions.write"];
      expect(
        (
          await dispatch("board.widget.grant", {
            name: "summary",
            revision: 1,
            instanceId: "not-a-grant",
            decision: "granted",
          })
        ).mock.calls[0],
      ).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    }));

  it.each(
    (["board.get", "board.widget.source"] as const).flatMap((method) =>
      (["current", "revoked", "replaced"] as const).map((change) => ({ method, change })),
    ),
  )("fences pending narrow $method reads after authority is $change", ({ method, change }) =>
    withState(async () => {
      const { client, cfg } = ownerFixture("board-read-owner");
      cfg.gateway!.roles!.definitions!.none!.scopes = [];
      const entry = { ...ownedEntry(client, "board-read"), visibility: "draft" as const };
      await upsertSessionEntryCore(scope, entry);
      await boardStore.putWidget({
        ...scope,
        name: "private-report",
        content:
          method === "board.get"
            ? reportContent("private report")
            : { kind: "html", html: "private source" },
      });
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      context.resolveGatewayContext = () => context;
      client.connect.scopes = ["operator.sessions.read"];
      using gate = createRequestGate();
      if (method === "board.get") {
        const load = boardStore.getSnapshotWithHtmlViewMetadata.bind(boardStore);
        vi.spyOn(boardStore, "getSnapshotWithHtmlViewMetadata").mockImplementation(
          async (target) => {
            const result = await load(target);
            await gate.pause();
            return result;
          },
        );
      } else {
        const load = boardStore.useWidgetDocument.bind(boardStore);
        vi.spyOn(boardStore, "useWidgetDocument").mockImplementation(async (...args) => {
          const result = await load(...args);
          await gate.pause();
          return result;
        });
      }
      const { request, respond } = startExactAuthorizationRequest(
        method,
        {
          sessionKey: key,
          ...(method === "board.widget.source" ? { name: "private-report" } : {}),
        },
        { client, context, extraHandlers: createBoardHandlers(boardStore) },
      );
      const settled = Promise.allSettled([request]);
      await gate.during(
        request,
        async () => {
          expect(respond).not.toHaveBeenCalled();
          if (change === "revoked") {
            await setCanonicalUserProfileRole(client.authenticatedUserProfile!.profileId, "none");
          } else if (change === "replaced") {
            await upsertSessionEntryCore(scope, {
              ...entry,
              sessionId: "board-read-replacement",
            });
          }
        },
        settled,
      );
      expect(respond.mock.calls.some(([ok]) => ok)).toBe(change === "current");
      if (change === "current") {
        expect(respond.mock.calls[0]?.[1]).toMatchObject(
          method === "board.get"
            ? { widgets: [expect.objectContaining({ name: "private-report" })] }
            : { name: "private-report", html: "private source" },
        );
      } else {
        expect(respond.mock.calls.every(([, payload]) => payload === undefined)).toBe(true);
      }
    }),
  );

  it.each([
    { owner: "connection", broad: false, rebind: true },
    { owner: "device", broad: true, rebind: false },
  ] as const)(
    "sessions.abort retains its invocation scope for a $owner foreign run (broad=$broad, rebind=$rebind)",
    ({ owner, broad, rebind }) =>
      withState(async () => {
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
      }),
  );

  it.each([
    { method: "sessions.send", phase: "routing drift" },
    { method: "sessions.send", phase: "committed creation" },
    { method: "sessions.create", phase: "routing drift" },
    { method: "sessions.create", phase: "committed creation" },
  ] as const)("$method preserves creation authority across $phase", ({ method, phase }) =>
    withState(async (state) => {
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
    }),
  );

  it.each(
    (["active", "queued", "agent"] as const).flatMap((kind) =>
      (["chat.abort", "sessions.abort"] as const).map((method) => ({ kind, method })),
    ),
  )(
    "$method narrow single and bulk Stop match the original $kind producer incarnation",
    ({ kind, method }) =>
      withState(async () => {
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
            if (kind === "agent") {
              run.adapter.kind = "agent";
            }
            rpcSourceTesting.set(runId, run);
            const before = [...context.dedupe];
            const respond = await dispatchAuthorizationRequest(
              method,
              {
                ...(method === "chat.abort" ? { sessionKey: requestKey } : { key: requestKey }),
                ...(explicit ? { runId } : {}),
              },
              { client, context, extraHandlers: stopHandlers },
              runId,
            );
            const allowed = mismatch === "none";
            expect(run.input.abortSignal.aborted).toBe(allowed);
            if (!allowed) {
              expect([...context.dedupe]).toEqual(before);
            }
            if (allowed) {
              expectAborted(respond, method, runId);
            }
            expect(respond).toHaveBeenCalledOnce();
            await finishRun(runId, run);
          }
        }
      }),
  );

  it.each(
    (
      [
        ["active", "chat.abort"],
        ["queued", "chat.abort"],
        ["queued", "sessions.abort"],
      ] as const
    ).flatMap(([kind, method]) =>
      (kind === "active"
        ? (["registration"] as const)
        : (["registration", "key", "sessionId", "agentId"] as const)
      ).map((changed) => ({ kind, method, changed })),
    ),
  )(
    "$method does not adopt a reentrant $kind producer $changed during narrow Stop",
    ({ kind, method, changed }) =>
      withState(async () => {
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
            if (changed === "registration") {
              // Reserve successors after Stop captures the original mailbox inputs.
              replacement = createActiveRun(key, target);
              runs.set("second", replacement);
            } else {
              const identity = {
                key: { sessionKey: "agent:main:other" },
                sessionId: { sessionId: "replacement" },
                agentId: { agentId: "replacement" },
              }[changed];
              setRpcSourceIdentityForTest(
                expectDefined(second, "queued narrow Stop source"),
                identity,
              );
            }
          },
          { once: true },
        );
        const respond = await dispatchAuthorizationRequest(
          method,
          method === "chat.abort" ? { sessionKey: key } : { key },
          { client, context, extraHandlers: stopHandlers },
          changed,
        );
        expect(first.input.abortSignal.aborted).toBe(true);
        if (kind === "queued") {
          expect(expectDefined(second, "queued narrow Stop source").input.abortSignal.aborted).toBe(
            false,
          );
        }
        if (changed === "registration") {
          expect(
            expectDefined(replacement, "reentrant narrow Stop successor").input.abortSignal.aborted,
          ).toBe(false);
        }
        expectAborted(respond, method, "first");
      }),
  );

  it.each(["key", "incarnation"] as const)(
    "lets broad Stop abort a different owned run %s",
    (changed) =>
      withState(async () => {
        const { client, cfg } = ownerFixture("stop-owner");
        client.connId = "same-connection";
        await upsertSessionEntryCore(scope, ownedEntry(client, "own-row"));
        client.connect.scopes = ["operator.write"];
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        const run = createActiveRun(changed === "key" ? "agent:main:other" : key, {
          agentId: "main",
          sessionId: changed === "key" ? "own-row" : "prior-incarnation",
          owner: { connId: client.connId },
        });
        rpcSourceTesting.set("different-run", run);
        const respond = await dispatchAuthorizationRequest(
          "chat.abort",
          { sessionKey: key, runId: "different-run" },
          { client, context, extraHandlers: { "chat.abort": handleChatAbortRequest } },
          changed,
        );
        expect(run.input.abortSignal.aborted).toBe(true);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        await finishRun("different-run", run);
      }),
  );

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
        using gate = createRequestGate();
        const effect = vi.fn();
        let current = true;
        const dispatch = vi
          .spyOn(chat, "handleDirectExternalChatSend")
          .mockImplementation(async (options) => {
            const authority = readGatewayRequestMutationAuthority(options);
            await gate.pause();
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
          await Promise.race([gate.entered, request]);
          expect(dispatch).toHaveBeenCalledOnce();
          if (changed === "source") {
            current = false;
          }
          if (changed === "generation") {
            await upsertSessionEntryCore(scope, { ...entry, lifecycleRevision: "replacement" });
          }
        } finally {
          gate.release();
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
    (changed) =>
      withState(async () => {
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
      }),
  );
});

describe("pending Stop admission", () => {
  const pendingKey = "agent:main:pending-stop";
  const pendingScope = { agentId: "main", sessionKey: pendingKey };
  const aborted = { status: "timeout", summary: "aborted" };

  async function createPendingOwner(profileName: string) {
    const { client, cfg, context } = ownerFixture(profileName);
    client.connId = "pending-owner";
    const entry = ownedEntry(client, "original");
    await upsertSessionEntryCore(pendingScope, entry);
    const stop = async (runId: string) => {
      const respond = await dispatchAuthorizationRequest(
        "chat.abort",
        { sessionKey: pendingKey, runId },
        { client, context, extraHandlers: { "chat.abort": handleChatAbortRequest } },
        "stop",
      );
      return respond.mock.calls[0]?.[1];
    };
    return { client, cfg, context, entry, stop };
  }

  it.each(["current", "replacement"] as const)(
    "does not treat an agent routing reservation as controller admission across %s row state",
    (target) =>
      withState(async () => {
        const { client, cfg, context, entry, stop } =
          await createPendingOwner("pending-agent-owner");
        const runId = `pending-agent-${target}`;
        const request = { message: "queued", ...pendingScope, idempotencyKey: runId };
        const routing = { cfg, request, runId, context, agentDedupeKeys: [`agent:${runId}`] };
        const lifecycle = createAgentDedupeLifecycle({
          ...routing,
          suppressVisibleSessionEffects: false,
          ownerConnId: client.connId,
          io: createAgentTurnIo(vi.fn()),
        });
        expect(
          await prepareAgentRequestRouting({
            ...routing,
            respond: vi.fn(),
            isRawModelRun: false,
            reserveDedupe: lifecycle.reserve,
            bindDedupeSessionTarget: lifecycle.bindSessionTarget,
            clearDedupe: lifecycle.clearUnaccepted,
          }),
        ).toBeDefined();
        expect(rpcSourceTesting.size).toBe(0);
        const pending = context.dedupe.get(`agent:${runId}`);
        if (target === "replacement") {
          await upsertSessionEntryCore(pendingScope, { ...entry, sessionId: "replacement" });
        }
        expect(await stop(runId)).toMatchObject({ aborted: false });
        expect(context.dedupe.get(`agent:${runId}`)).toBe(pending);
      }),
  );

  it("keeps a real chat admission abortable while its original session lifecycle is held", () =>
    withState(async () => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const { client, context, stop } = await createPendingOwner("pending-chat-owner");
      const runId = "pending-chat-admission";
      const request = await normalizeChatSendRequest({
        params: { sessionKey: pendingKey, message: "queued", idempotencyKey: runId },
        client,
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const session = await prepareChatSendSession({ request: request.value, client, context });
      if (!session.ok) {
        throw new Error("chat session preparation failed");
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const hold = runSessionMutation({
        scope: session.value.storePath,
        identities: [pendingKey, "original"],
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      const preparedSession = await qualifyChatSendSession(session.value);
      const admission = admitChatSend({
        request: request.value,
        session: preparedSession,
        client,
        context,
        respond: vi.fn(),
      });
      try {
        await vi.waitFor(() =>
          expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true),
        );
        expect(rpcSourceTesting.has(runId)).toBe(false);
        expect(await stop(runId)).toMatchObject({ aborted: true, runIds: [runId] });
      } finally {
        release.resolve();
        await hold;
        const settled = await admission;
        if (settled.ok) {
          settled.value.cleanupAdmittedRun();
        }
        expect(settled.ok).toBe(false);
        expect(context.dedupe.get(`chat:${runId}`)?.payload).toMatchObject(aborted);
      }
    }));
});

describe("guest dictation request boundary", () => {
  it("binds transcription audio and close to the owned session and connection", () =>
    withState(async () => {
      const { client, context } = ownerFixture("dictation-owner");
      client.connId = "guest-dictation-owner";
      await upsertSessionEntryCore(scope, ownedEntry(client, "dictation-session"));
      const config = await import("./talk/session-config.js");
      const { talkSessionHandlers } = await import("./talk/handlers/session.js");
      const sttSession = {
        connect: vi.fn(async () => {}),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
      vi.spyOn(config, "buildTalkTranscriptionConfig").mockResolvedValue({
        provider: "test",
        providers: {},
        model: undefined,
        file: undefined,
      });
      let transcript: ((text: string) => void) | undefined;
      vi.spyOn(config, "resolveConfiguredRealtimeTranscriptionProvider").mockResolvedValue({
        provider: {
          id: "test",
          label: "Test",
          isConfigured: () => true,
          createSession: (request) => {
            transcript = request.onTranscript;
            return sttSession;
          },
        },
        providerConfig: {},
      });
      const request = (method: string, params: unknown, requester = client) =>
        dispatchAuthorizationRequest(method, params, {
          client: requester,
          context,
          extraHandlers: talkSessionHandlers,
        });
      const created = await request("talk.session.create", {
        sessionKey: key,
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      });
      expect(created).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          mode: "transcription",
          brain: "none",
        }),
        undefined,
      );
      const session = created.mock.calls.at(-1)?.[1] as { sessionId: string };
      expect(session.sessionId).toBeTruthy();
      const other = roleClient("view", "dictation-other");
      other.connId = "guest-dictation-other";
      other.connect.scopes = ["operator.sessions.write"];
      const denied = await request(
        "talk.session.appendAudio",
        {
          sessionId: session.sessionId,
          audioBase64: "AAA=",
        },
        other,
      );
      expect(denied.mock.calls.at(-1)?.[0]).toBe(false);
      const appended = await request("talk.session.appendAudio", {
        sessionId: session.sessionId,
        audioBase64: "AAA=",
      });
      expect(appended.mock.calls.at(-1)?.[0]).toBe(true);
      expect(sttSession.sendAudio).toHaveBeenCalled();
      expectDefined(transcript, "transcription callback")("dictation result");
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "talk.event",
        expect.objectContaining({ text: "dictation result", final: true }),
        new Set([client.connId]),
        expect.anything(),
      );
      const closed = await request("talk.session.close", {
        sessionId: session.sessionId,
      });
      expect(closed.mock.calls.at(-1)?.[0]).toBe(true);
      expect(sttSession.close).toHaveBeenCalled();
      expect(
        (await request("talk.session.create", { sessionKey: key, mode: "realtime" })).mock.calls.at(
          -1,
        )?.[0],
      ).toBe(false);
      const reopened = await request("talk.session.create", {
        sessionKey: key,
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      });
      expect(reopened.mock.calls.at(-1)?.[0]).toBe(true);
      const broadcast = vi.mocked(context.broadcastToConnIds);
      broadcast.mockClear();
      client.invalidated = true;
      expectDefined(transcript, "transcription callback")("revoked recording text");
      expect(broadcast).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: "revoked recording text" }),
        expect.anything(),
        expect.anything(),
      );
      expect(sttSession.close).toHaveBeenCalledTimes(2);
    }));
});
