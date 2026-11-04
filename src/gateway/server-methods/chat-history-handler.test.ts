import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import * as coldStorageRead from "../../config/sessions/session-cold-storage-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as modelAccounts from "../../state/user-model-accounts.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import {
  seedHistorySession as seedSession,
  expectHistorySuccess as expectSuccess,
  expectHistoryFailure as expectFailure,
  requestHistory,
} from "./chat-history-fixtures.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import * as metadataCases from "./chat-metadata-ownership.test-support.js";
import { connectChatMetadataAccount } from "./chat-metadata-runtime.test-support.js";
import { captureRpcTargetForTest } from "./rpc-source-fixtures.test-support.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

async function withHistoryState(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await captureRuntimeConfigAsyncReader()();
    await run();
  });
}

function adminClient(id: string) {
  const client = identifiedClient(id);
  client.connect.scopes = ["operator.admin"];
  return client;
}

function appendText(
  scope: Parameters<typeof sessions.appendTranscriptMessage>[0],
  content: string,
  timestamp: number,
  role: "user" | "assistant" = "user",
  eventId?: string,
) {
  return sessions.appendTranscriptMessage(scope, {
    eventId,
    message: { role, content, timestamp },
  });
}

function historyCase(run: (method: string) => Promise<void>) {
  return (method: string) => withHistoryState(() => run(method));
}

function createPersonalMetadataFixture() {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const authProfileId = connectChatMetadataAccount(owner.id);
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "metadata-owner-connection",
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserProfile: gatewayProfile(owner.id, owner.displayName, owner.updatedAt),
  };
  const config = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
        },
      },
    },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config);
  const clients = new Set([client]);
  const metadata = { models: [], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    readChatMetadata,
    getClientConnIds: (filter) =>
      new Set(clients.has(client) && (!filter || filter(client)) ? [client.connId] : []),
  });
  const request = (
    params: Record<string, unknown>,
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> = {},
  ) =>
    requestHistory(
      "chat.metadata",
      params,
      context,
      overrides.client === undefined ? client : overrides.client,
      undefined,
      false,
      overrides.signal,
    );
  return { owner, authProfileId, client, clients, config, metadata, readChatMetadata, request };
}

it("serves notices only to Control UI through worker history, startup, delta, and exact hydration", () =>
  withHistoryState(async () => {
    const scope = await seedSession("plugin-steering");
    const guidance = "Keep the change small.";
    const plugin = { pluginId: "reviewer", pluginName: "Reviewer" };
    const visibleNote = { display: true, content: [{ type: "text", text: guidance }] };
    await sessions.appendTranscriptMessage(scope, {
      eventId: "question",
      now: 1,
      message: { role: "user", content: "Question" },
    });
    const context = await createHistoryReadContext();
    const client = adminClient("steering-reader");
    const request = async (method: string, params: Record<string, unknown> = {}) =>
      expectSuccess(
        await requestHistory(
          method,
          { sessionKey: scope.sessionKey, ...params },
          context,
          client,
          undefined,
          true,
        ),
      );
    const cursor = (await request("chat.history")).deltaCursor;
    expect(typeof cursor).toBe("string");
    await sessions.appendTranscriptMessage(scope, {
      eventId: "plugin-note",
      now: 2,
      message: {
        role: "user",
        display: false,
        content: `Private model prefix\n\n${guidance}`,
        provenance: { kind: "internal_system", sourceTool: "plugin:reviewer" },
        __openclaw: { pluginSteering: { ...plugin, displayText: guidance } },
      },
    });
    await sessions.appendTranscriptMessage(scope, {
      eventId: "hidden-exec",
      now: 3,
      message: {
        role: "user",
        display: false,
        content: "Private exec output",
        provenance: { kind: "internal_system", sourceTool: "exec" },
      },
    });
    for (const id of [GATEWAY_CLIENT_IDS.CONTROL_UI, GATEWAY_CLIENT_IDS.TUI]) {
      client.connect.client = { ...client.connect.client, id, mode: "webchat" };
      const visible = id === GATEWAY_CLIENT_IDS.CONTROL_UI;
      for (const method of ["chat.history", "chat.startup"]) {
        const response = await request(method);
        expect(response.messages).toHaveLength(visible ? 2 : 1);
        if (visible) {
          expect(response.messages).toContainEqual(
            expect.objectContaining({
              ...visibleNote,
              __openclaw: expect.objectContaining({
                pluginSteering: expect.objectContaining(plugin),
              }),
            }),
          );
        }
      }
      const delta = await request("chat.history", { cursor });
      expect(delta.kind).toBe("delta");
      expect(delta.messages).toHaveLength(visible ? 1 : 0);
      const exact = await request("chat.message.get", { messageId: "plugin-note" });
      expect(exact.ok).toBe(visible);
      if (visible) {
        expect(exact.message).toMatchObject(visibleNote);
      }
    }
  }));

it.each(["chat.history", "chat.startup"] as const)(
  "%s keeps selection session-only for an agent with an explicit default",
  (method) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) => {
      const cfg = {
        agents: {
          defaults: { model: "openai/gpt-5.6-sol" },
          ownership: "explicit",
          entries: { main: {}, work: { model: "anthropic/claude-sonnet-4-6" } },
        },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "work", sessionKey: "agent:work:main", sessionId: "work-main" };
      await sessions.upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const respond = await requestHistory(
        method,
        { agentId: scope.agentId, sessionKey: scope.sessionKey },
        await createHistoryReadContext({ getRuntimeConfig: () => cfg }),
        { connect: { scopes: ["operator.admin"] } } as never,
      );
      expect(expectSuccess(respond).defaults).toMatchObject({
        modelSelectionTarget: "session",
      });
    }),
);

it("chat.history reports the session agent's own verboseDefault", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) => {
    const cfg = {
      agents: {
        defaults: { verboseDefault: "off" },
        entries: { main: {}, ops: { verboseDefault: "full" } },
      },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
    const client = { connect: { scopes: ["operator.admin"] } } as never;
    for (const [agentId, expected] of [
      ["ops", "full"],
      ["main", "off"],
    ] as const) {
      const scope = { agentId, sessionKey: `agent:${agentId}:main`, sessionId: `${agentId}-main` };
      await sessions.upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const payload = expectSuccess(
        await requestHistory("chat.history", { sessionKey: scope.sessionKey }, context, client),
      );
      expect(payload.verboseLevel).toBe(expected);
      expect(payload.sessionInfo).toMatchObject({ verboseLevel: expected });
    }
  }));

it.each(["chat.history", "chat.startup"] as const)(
  "%s projects unbound canonical ACP metadata without host ACP reads",
  historyCase(async (method) => {
    const sessionKey = "agent:main:acp:unbound-history";
    seedCanonicalAcpSessionMeta({
      sessionKey,
      meta: {
        backend: "acpx",
        agent: "main",
        runtimeSessionName: "unbound-history",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });
    const context = await createHistoryReadContext();
    const client = adminClient("unbound-history-operator");
    const respond = vi.fn<RespondFn>();
    const hostSql = observeHostDataSql();
    try {
      await requestHistory(method, { sessionKey }, context, client, respond);
      const info = asOptionalRecord(expectSuccess(respond).sessionInfo);
      assert(info, "session info");
      expect(info.runtimeSelectionLocked).toBe(true);
      expect(info.agentRuntime).toEqual({
        id: "acpx",
        source: "session-key",
        cloudPlacementSupported: false,
        devicePlacementSupported: false,
      });
      expect(hostSql.queries.filter((sql) => /\bacp_sessions\b/i.test(sql))).toEqual([]);
    } finally {
      hostSql.restore();
    }
  }),
);

it.each(["chat.history", "chat.startup"] as const)(
  "%s carries current caller sharing controls on sessionInfo",
  historyCase(async (method) => {
    const scope = { agentId: "main", sessionKey: "agent:main:sharing-history" };
    await sessions.upsertSessionEntryCore(scope, {
      sessionId: "sharing-history",
      updatedAt: Date.now(),
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    for (const role of ["owner", "admin", "viewer"] as const) {
      const client = identifiedClient(role);
      if (role === "admin") {
        client.connect.scopes = ["operator.admin"];
      }
      const respond = await requestHistory(method, scope, await createHistoryReadContext(), client);
      expect(expectSuccess(respond).sessionInfo).toMatchObject({
        sessionId: "sharing-history",
        sharingRole: role,
        visibility: "read-only",
      });
    }
  }),
);

it.each(["chat.history", "chat.startup"] as const)(
  "%s refreshes sharing after startup work and rejects a replaced session",
  historyCase(async (method) => {
    const scope = { agentId: "main", sessionKey: "agent:main:sharing-history-race" };
    await sessions.upsertSessionEntryCore(scope, {
      sessionId: "sharing-history-race",
      updatedAt: Date.now(),
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    const client = adminClient("viewer");
    const readChatStartupProjection = vi.fn(async () => {
      client.connect.scopes = ["operator.read", "operator.write"];
      await sessions.patchSessionEntryCore(scope, () => ({ visibility: "read-only" }));
      return undefined;
    });
    const context = await createHistoryReadContext({ readChatStartupProjection });
    const call = () => requestHistory(method, scope, context, client);
    expect(expectSuccess(await call()).sessionInfo).toMatchObject({
      sharingRole: "viewer",
      visibility: "read-only",
    });
    readChatStartupProjection.mockImplementationOnce(async () => {
      await sessions.patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      return undefined;
    });
    expectFailure(await call(), "INVALID_REQUEST");
    await sessions.patchSessionEntryCore(scope, () => ({ visibility: "read-only" }));
    readChatStartupProjection.mockImplementationOnce(async () => {
      await sessions.patchSessionEntryCore(scope, () => ({ sessionId: "replacement-history" }));
      return undefined;
    });
    expectFailure(await call(), "UNAVAILABLE", true);
  }),
);

it.each([
  { method: "chat.history", change: "revocation", code: "INVALID_REQUEST" },
  { method: "chat.startup", change: "revocation", code: "INVALID_REQUEST" },
  { method: "chat.history", change: "replacement", code: "UNAVAILABLE" },
  { method: "chat.startup", change: "replacement", code: "UNAVAILABLE" },
  { method: "chat.history", change: "reset", code: "UNAVAILABLE" },
  { method: "chat.startup", change: "reset", code: "UNAVAILABLE" },
  { method: "chat.history", change: "sharing metadata", code: "UNAVAILABLE" },
  { method: "chat.startup", change: "sharing metadata", code: "UNAVAILABLE" },
] as const)(
  "$method rejects a delta after $change during transcript restoration",
  ({ method, change, code }) =>
    withHistoryState(async () => {
      const scope = await seedSession("delta-publication", {
        lifecycleRevision: "before-reset",
        sessionStartedAt: 1,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      await appendText(scope, "before cursor", 1);
      const client = identifiedClient("viewer");
      const context = await createHistoryReadContext();
      const call = (cursor?: string) =>
        requestHistory(
          method,
          { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) },
          context,
          client,
        );
      const initial = await call();
      const initialResponse = expectSuccess(initial);
      expect(initialResponse).toMatchObject({
        sessionInfo: { sessionId: scope.sessionId, lifecycleRevision: "before-reset" },
      });
      const cursor = initialResponse.deltaCursor;
      assert(typeof cursor === "string", "expected initial delta cursor");
      await appendText(scope, "private delta content", 2, "assistant");
      const entered = createDeferred();
      const release = createDeferred();
      const read = coldStorageRead.readRestoredSessionTranscript;
      using readSpy = vi.spyOn(coldStorageRead, "readRestoredSessionTranscript");
      readSpy.mockImplementationOnce(async function delayedRead<T>(
        readScope: sessions.SessionTranscriptReadScope,
        readSnapshot: () => T,
      ): Promise<T> {
        const result = await read(readScope, readSnapshot);
        entered.resolve();
        await release.promise;
        return result;
      });
      const pending = call(cursor);
      try {
        await Promise.race([entered.promise, pending]);
        expect(readSpy).toHaveBeenCalledOnce();
        await sessions.patchSessionEntryCore(scope, () =>
          change === "replacement"
            ? { sessionId: "replacement" }
            : change === "reset"
              ? { lifecycleRevision: "after-reset", sessionStartedAt: 3 }
              : { visibility: change === "revocation" ? "draft" : "read-only" },
        );
      } finally {
        release.resolve();
        await pending;
      }
      const respond = await pending;
      expectFailure(respond, code, code === "UNAVAILABLE");
      expect(JSON.stringify(respond.mock.calls)).not.toContain("private delta content");
      if (change === "reset") {
        // A reset can retain the physical transcript ID while invalidating cached full messages.
        expect(expectSuccess(await call()).sessionInfo).toMatchObject({
          sessionId: scope.sessionId,
          lifecycleRevision: "after-reset",
        });
      }
    }),
);

it.each([
  { inputRunIds: Array.from({ length: 51 }, (_, index) => `run-${index}`) },
  { inputRunIds: ["r".repeat(257)] },
])("rejects oversized receipt queries before reading session state", async ({ inputRunIds }) => {
  const respond = await requestHistory(
    "chat.history",
    { sessionKey: "main", inputRunIds },
    createDirectChatContext(),
  );
  expectFailure(respond, "INVALID_REQUEST");
});

it.each(["chat.history", "chat.startup"] as const)(
  "%s projects fresh owned session state without another preparation copy",
  historyCase(async (method) => {
    const now = Date.now();
    const childScope = { agentId: "main", sessionKey: "agent:main:subagent:history-child" };
    const toolOverrides = { mcpToolsDeny: { synthetic: ["blocked"] } };
    const skillsSnapshot = { prompt: "history unused saved prompt", skills: [] };
    const scope = await seedSession("history-owned", {
      updatedAt: now,
      thinkingLevel: "high",
      toolOverrides,
      skillsSnapshot,
    });
    await sessions.upsertSessionEntryCore(childScope, {
      sessionId: "history-child",
      updatedAt: now,
      parentSessionKey: scope.sessionKey,
      spawnedBy: scope.sessionKey,
      skillsSnapshot,
    });
    const context = await createHistoryReadContext();
    const call = async () => {
      const respond = vi.fn<RespondFn>();
      using cloneSpy = vi.spyOn(globalThis, "structuredClone");
      using parseSpy = vi.spyOn(JSON, "parse");
      await requestHistory(method, { sessionKey: scope.sessionKey }, context, null, respond);
      const preparationCopies = cloneSpy.mock.calls.filter(
        ([value]) =>
          asOptionalRecord(value)?.sessionId === scope.sessionId &&
          asOptionalRecord(value)?.toolOverrides !== undefined,
      ).length;
      expect(parseSpy.mock.calls.some(([value]) => value.includes(skillsSnapshot.prompt))).toBe(
        false,
      );
      expect(
        parseSpy.mock.calls.filter(([value]) => value.includes('"sessionId":"history-child"'))
          .length,
      ).toBeLessThanOrEqual(1);
      expect(preparationCopies).toBe(0);
      return expectSuccess(respond);
    };

    const first = await call();
    expect(first).toMatchObject({ thinkingLevel: "high", toolOverrides });
    expect(first.sessionInfo).toMatchObject({ childSessions: [childScope.sessionKey] });
    const deniedTools = asOptionalRecord(
      asOptionalRecord(first.toolOverrides)?.mcpToolsDeny,
    )?.synthetic;
    assert(Array.isArray(deniedTools), "expected nested denied tool array");
    deniedTools.push("response-only");
    expect(toolOverrides.mcpToolsDeny.synthetic).toEqual(["blocked"]);
    expect((await call()).toolOverrides).toEqual(toolOverrides);

    await sessions.updateSessionEntry(scope, () => ({ thinkingLevel: "low", updatedAt: now + 1 }));
    await sessions.updateSessionEntry(childScope, () => ({
      parentSessionKey: "agent:main:other-parent",
      spawnedBy: "agent:main:other-parent",
      updatedAt: now + 1,
    }));
    const fresh = await call();
    expect(fresh).toMatchObject({ thinkingLevel: "low", toolOverrides });
    expect(asOptionalRecord(fresh.sessionInfo)?.childSessions).toBeUndefined();
    expect(first.thinkingLevel).toBe("high");
  }),
);

it.each(["chat.history", "chat.startup"] as const)(
  "%s reuses measured history bytes while preserving the recovery boundary",
  historyCase(async (method) => {
    const scope = await seedSession("history-bytes");
    const marker = "history-byte-fixture";
    for (let index = 0; index < 12; index++) {
      await appendText(
        scope,
        `${marker}-${index}: ${'漢字\n"\\'.repeat(100)}`,
        index + 1,
        index % 2 === 0 ? "user" : "assistant",
      );
    }
    const context = await createHistoryReadContext();
    const call = async (params: Record<string, unknown> = {}) => {
      const respond = vi.fn<RespondFn>();
      const stringify = JSON.stringify;
      let historyArrayBytes = 0;
      using serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
        const result = stringify(...args);
        if (
          Array.isArray(args[0]) &&
          args[0].some((value) => {
            const record = asOptionalRecord(value);
            return record?.role === "user" || asOptionalRecord(record?.message)?.role === "user";
          }) &&
          typeof result === "string" &&
          result.includes(marker)
        ) {
          historyArrayBytes += Buffer.byteLength(result);
        }
        return result;
      });
      await requestHistory(
        method,
        { sessionKey: scope.sessionKey, ...params },
        context,
        null,
        respond,
      );
      serialization.mockRestore();
      expect(historyArrayBytes).toBe(0);
      return expectSuccess(respond);
    };
    const inactive = await call();
    expect(inactive.messages).toHaveLength(12);
    expect(inactive.inFlightRun).toBeUndefined();
    const historyJson = JSON.stringify(inactive.messages);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registration = registerChatAbortController({
      target: captureRpcTargetForTest(scope),
      runId: "run-history-bytes",
      ...scope,
      timeoutMs: 60_000,
    });
    assert(registration.entry, "history source");
    const releaseSource = await claimRpcSourceForTest(registration.entry);
    const run = context.chatRunState.getOrCreate("run-history-bytes");
    run.buffer = "partial reply ".repeat(1_000);
    run.planSnapshot = { steps: [{ step: "Read history", status: "in_progress" }] };
    const expected = {
      runId: "run-history-bytes",
      text: run.buffer,
      startedAt: 1_000,
      plan: run.planSnapshot,
    };
    const exactBytes = Buffer.byteLength(historyJson) + Buffer.byteLength(JSON.stringify(expected));
    clock.mockReturnValue(1_800_000_000_000);
    try {
      const bounded = await call({ maxBytes: exactBytes - 1 });
      expect(bounded.messages).toEqual(inactive.messages);
      expect(bounded.inFlightRun).toEqual({ ...expected, text: "" });
      const exact = await call({ maxBytes: exactBytes });
      expect(exact.messages).toEqual(inactive.messages);
      expect(exact.inFlightRun).toEqual(expected);
      const delta = await call({ cursor: exact.deltaCursor, maxBytes: exactBytes });
      expect(delta).toMatchObject({ kind: "delta", messages: [], inFlightRun: expected });
      await appendText(scope, `${marker}: ${'漢字\n"\\🤖'.repeat(100)}`, 13, "user", "delta-user");
      await sessions.appendTranscriptMessage(scope, {
        eventId: "delta-tool",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "read-delta", name: "read", arguments: {} }],
          timestamp: 14,
        },
      });
      const appended = await call({ cursor: exact.deltaCursor });
      expect(appended).toMatchObject({
        kind: "delta",
        messages: [{ messageId: "delta-user" }, { messageId: "delta-tool" }],
        activity: [{ messageId: "delta-tool" }],
        inFlightRun: expected,
      });
      const deltaBytes =
        Buffer.byteLength(JSON.stringify(appended.messages)) +
        Buffer.byteLength(JSON.stringify({ activity: appended.activity })) -
        1 +
        Buffer.byteLength(JSON.stringify(expected));
      for (const extraBytes of [0, -1]) {
        const page = await call({ cursor: exact.deltaCursor, maxBytes: deltaBytes + extraBytes });
        expect(page.messages).toEqual(appended.messages);
        expect(page.activity).toEqual(appended.activity);
        expect(page.inFlightRun).toEqual(extraBytes === 0 ? expected : { ...expected, text: "" });
        expect(page).not.toHaveProperty("messagesBytes");
        expect(page).not.toHaveProperty("activityBytes");
      }
      expect(delta).not.toHaveProperty("messagesBytes");
      expect(delta).not.toHaveProperty("activityBytes");
      expect(JSON.stringify(inactive.messages)).toBe(historyJson);
    } finally {
      clock.mockRestore();
      releaseSource();
      registration.cleanup();
      context.chatRunState.clearRun("run-history-bytes");
    }
    const completed = await call();
    expect(completed.messages).toHaveLength(14);
    assert(Array.isArray(completed.messages), "Expected completed history messages");
    expect(completed.messages.slice(0, 12)).toEqual(inactive.messages);
    expect(completed.inFlightRun).toBeUndefined();
  }),
);

it("previews a retained personal account with read scope without changing its cleared default", () =>
  withOpenClawTestState({ layout: "state-only", prepareProfileCatalog: true }, async () => {
    const { owner, authProfileId, metadata, readChatMetadata, request } =
      createPersonalMetadataFixture();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    modelAccounts.clearUserProfileAuthLink({ profileId: owner.id, provider: "openai" });
    const before = modelAccounts.readUserModelAuthProfile(authProfileId);

    const respond = await request({ agentId: "main", authProfileId });

    expect(respond).toHaveBeenCalledWith(true, metadata);
    expect(readChatMetadata.mock.lastCall?.[0]).toMatchObject({
      agentId: "main",
      requesterProfileId: owner.id,
      draftAccountSelection: { owner: owner.id, authProfileId },
    });
    expect(modelAccounts.listUserProfileAuthLinks(owner.id)).toEqual([]);
    expect(modelAccounts.readUserModelAuthProfile(authProfileId)).toEqual(before);
  }));

metadataCases.registerMetadataCallerCases(createPersonalMetadataFixture);

metadataCases.registerMetadataRevocationCases(createPersonalMetadataFixture);

it("reads the persisted session profile without contaminating neutral agent metadata", () =>
  withHistoryState(async () => {
    const sessionKey = "agent:main:locked";
    await seedSession("locked", {
      authProfileOverride: "test:locked",
      authProfileOverrideSource: "user",
    });
    const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => ({
      commands: [],
      models: [],
      swarmEnabled: false,
    }));
    const respond = vi.fn<RespondFn>();
    const context = createDirectChatContext({ readChatMetadata });
    const call = (params: Record<string, unknown>) =>
      requestHistory("chat.metadata", params, context, null, respond);
    for (const params of [{ agentId: "   ", sessionKey }, { agentId: "main" }]) {
      await call(params);
    }
    const saved = readChatMetadata.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      agentId: "main",
      sessionKey,
      sessionEntry: { authProfileOverride: "test:locked", authProfileOverrideSource: "user" },
    });
    const neutral = expectDefined(readChatMetadata.mock.calls[1]?.[0], "neutral metadata read");
    expect(neutral).toMatchObject({ agentId: "main", requesterProfileId: undefined });
    expect(neutral).not.toHaveProperty("sessionEntry");
    expect(neutral).not.toHaveProperty("draftAccountSelection");
    expect(neutral.isCurrent?.()).toBe(true);
    expectDefined(neutral.assertCurrent, "neutral metadata authority check")();
    expect(respond).toHaveBeenCalledTimes(2);
    readChatMetadata.mockClear();
    await call({ agentId: "other", sessionKey });
    expect(readChatMetadata).not.toHaveBeenCalled();
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  }));

it("returns a typed selection error for an ownerless explicit fleet", async () => {
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
  };
  const readChatMetadata = vi.fn();
  const respond = await requestHistory(
    "chat.metadata",
    {},
    createDirectChatContext({ getRuntimeConfig: () => config, readChatMetadata }),
  );

  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    }),
  );
  expect(readChatMetadata).not.toHaveBeenCalled();
});
