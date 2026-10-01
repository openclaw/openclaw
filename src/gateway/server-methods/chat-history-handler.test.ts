import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
  updateSessionEntry,
  upsertSessionEntryCore,
  type SessionTranscriptReadScope,
} from "../../config/sessions/session-accessor.js";
import * as coldStorageRead from "../../config/sessions/session-cold-storage-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { connectChatMetadataAccount } from "./chat-metadata-runtime.test-support.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

function createPersonalMetadataFixture() {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const authProfileId = connectChatMetadataAccount(owner.id);
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "metadata-owner-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: owner.id,
      displayName: owner.displayName,
      hasAvatar: false,
      updatedAt: owner.updatedAt,
    },
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
  const clients = new Set([client]);
  const metadata = { models: [], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    readChatMetadata,
    getClientConnIds: (filter) =>
      new Set(
        [...clients]
          .filter((current) => !filter || filter(current))
          .map((current) => current.connId),
      ),
  });
  const request = async (
    params: Record<string, unknown>,
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      "metadata handler",
    )({
      params,
      context,
      client,
      respond,
      req: { type: "req", id: "draft-preview", method: "chat.metadata" },
      isWebchatConnect: () => false,
      ...overrides,
    });
    return respond;
  };
  return { owner, authProfileId, client, clients, config, metadata, readChatMetadata, request };
}

describe("chat history model selection defaults", () => {
  it("keeps a stored literal global conversation separate from main in per-sender scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { scope: "per-sender" },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      for (const agentId of ["ops", "research"]) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: "global" },
          { sessionId: `global-${agentId}`, updatedAt: 1 },
        );
      }
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: "agent:research:main" },
        { sessionId: "main-research", updatedAt: 1 },
      );
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      const client = identifiedClient("literal-global-operator");
      client.connect.scopes = ["operator.admin"];
      for (const [sessionKey, sessionId] of [
        ["global", "global-research"],
        ["agent:research:main", "main-research"],
      ]) {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey, agentId: "research" },
          context,
          req: { type: "req", id: "literal-global", method: "chat.history" },
          client,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ sessionKey, sessionId }),
        );
      }
    });
  });

  it.each(["chat.history", "chat.startup"] as const)(
    "%s keeps selection session-only for an agent with an explicit default",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: {
            defaults: { model: "openai/gpt-5.6-sol" },
            ownership: "explicit",
            entries: {
              main: {},
              work: { model: "anthropic/claude-sonnet-4-6" },
            },
          },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        const scope = {
          agentId: "work",
          sessionKey: "agent:work:main",
          sessionId: "work-main",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        let result: unknown;

        await expectDefined(
          chatHistoryHandlers[method],
          "history handler",
        )({
          params: { agentId: scope.agentId, sessionKey: scope.sessionKey },
          context: await createHistoryReadContext({ getRuntimeConfig: () => cfg }),
          req: { type: "req", id: "model-target", method },
          client: { connect: { scopes: ["operator.admin"] } } as never,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            expect(error).toBeUndefined();
            expect(ok).toBe(true);
            result = payload;
          },
        });

        const response = expectDefined(asOptionalRecord(result), "history response");
        expect(response.defaults).toMatchObject({ modelSelectionTarget: "session" });
      });
    },
  );
});

describe("chat history sharing projection", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s carries current caller sharing controls on sessionInfo",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = { agentId: "main", sessionKey: "agent:main:sharing-history" };
        await upsertSessionEntryCore(scope, {
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
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            chatHistoryHandlers[method],
            "history handler",
          )({
            params: scope,
            client,
            context: await createHistoryReadContext(),
            respond,
            req: { type: "req", id: "sharing-history", method },
            isWebchatConnect: () => false,
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              sessionInfo: expect.objectContaining({
                sessionId: "sharing-history",
                sharingRole: role,
                visibility: "read-only",
              }),
            }),
          );
        }
      });
    },
  );

  it.each(["chat.history", "chat.startup"] as const)(
    "%s refreshes sharing after startup work and rejects a replaced session",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = { agentId: "main", sessionKey: "agent:main:sharing-history-race" };
        await upsertSessionEntryCore(scope, {
          sessionId: "sharing-history-race",
          updatedAt: Date.now(),
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        const client = identifiedClient("viewer");
        client.connect.scopes = ["operator.admin"];
        const readChatStartupProjection = vi.fn(async () => {
          client.connect.scopes = ["operator.read", "operator.write"];
          await patchSessionEntryCore(scope, () => ({ visibility: "read-only" }));
          return undefined;
        });
        const context = await createHistoryReadContext({ readChatStartupProjection });
        const call = async () => {
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            chatHistoryHandlers[method],
            "history handler",
          )({
            params: scope,
            client,
            context,
            respond,
            req: { type: "req", id: "sharing-history-race", method },
            isWebchatConnect: () => false,
          });
          return respond;
        };
        expect(await call()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            sessionInfo: expect.objectContaining({
              sharingRole: "viewer",
              visibility: "read-only",
            }),
          }),
        );
        readChatStartupProjection.mockImplementationOnce(async () => {
          await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
          return undefined;
        });
        expect(await call()).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        await patchSessionEntryCore(scope, () => ({ visibility: "read-only" }));
        readChatStartupProjection.mockImplementationOnce(async () => {
          await patchSessionEntryCore(scope, () => ({ sessionId: "replacement-history" }));
          return undefined;
        });
        expect(await call()).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
        );
      });
    },
  );
});

describe("chat history delta publication", () => {
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
    async ({ method, change, code }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:delta-publication",
          sessionId: "delta-publication",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          lifecycleRevision: "before-reset",
          sessionStartedAt: 1,
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "before cursor", timestamp: 1 },
        });
        const client = identifiedClient("viewer");
        const context = await createHistoryReadContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async (cursor?: string) => {
          const respond = vi.fn<RespondFn>();
          await handler({
            params: { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) },
            client,
            context,
            respond,
            req: { type: "req", id: "delta-publication", method },
            isWebchatConnect: () => false,
          });
          return respond;
        };
        const initial = await call();
        const initialResponse = expectDefined(initial.mock.calls[0], "initial response");
        expect(initialResponse[0]).toBe(true);
        const cursor = asOptionalRecord(initialResponse[1])?.deltaCursor;
        if (typeof cursor !== "string") {
          throw new Error("expected initial delta cursor");
        }
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: "private delta content", timestamp: 2 },
        });
        const entered = createDeferred();
        const release = createDeferred();
        const read = coldStorageRead.readRestoredSessionTranscript;
        const readSpy = vi.spyOn(coldStorageRead, "readRestoredSessionTranscript");
        readSpy.mockImplementationOnce(async function delayedRead<T>(
          readScope: SessionTranscriptReadScope,
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
          await patchSessionEntryCore(scope, () =>
            change === "replacement"
              ? { sessionId: "replacement" }
              : change === "reset"
                ? { lifecycleRevision: "after-reset", sessionStartedAt: 3 }
                : { visibility: change === "revocation" ? "draft" : "read-only" },
          );
        } finally {
          release.resolve();
          try {
            await pending;
          } finally {
            readSpy.mockRestore();
          }
        }
        const respond = await pending;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({ code, ...(code === "UNAVAILABLE" ? { retryable: true } : {}) }),
        );
        expect(JSON.stringify(respond.mock.calls)).not.toContain("private delta content");
      });
    },
  );
});

describe("chat history consumption receipts", () => {
  it.each([
    { inputRunIds: Array.from({ length: 51 }, (_, index) => `run-${index}`) },
    { inputRunIds: ["r".repeat(257)] },
  ])("rejects oversized receipt queries before reading session state", async ({ inputRunIds }) => {
    const context = createDirectChatContext();
    const respond = vi.fn();
    await expectDefined(
      chatHistoryHandlers["chat.history"],
      "history handler",
    )({
      params: { sessionKey: "main", inputRunIds },
      context,
      respond,
      req: { type: "req", id: "bounds", method: "chat.history" },
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

describe("chat history exact-entry snapshots", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s projects fresh owned session state without another preparation copy",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const now = Date.now();
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:history-owned",
          sessionId: "history-owned",
        };
        const childScope = { agentId: "main", sessionKey: "agent:main:subagent:history-child" };
        const toolOverrides = { mcpToolsDeny: { synthetic: ["blocked"] } };
        const skillsSnapshot = { prompt: "history unused saved prompt", skills: [] };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: now,
          thinkingLevel: "high",
          toolOverrides,
          skillsSnapshot,
        });
        await upsertSessionEntryCore(childScope, {
          sessionId: "history-child",
          updatedAt: now,
          parentSessionKey: scope.sessionKey,
          spawnedBy: scope.sessionKey,
          status: "running",
          skillsSnapshot,
        });
        const context = await createHistoryReadContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async () => {
          const respond = vi.fn();
          const cloneSpy = vi.spyOn(globalThis, "structuredClone");
          const parseSpy = vi.spyOn(JSON, "parse");
          try {
            const pending = handler({
              params: { sessionKey: scope.sessionKey },
              context,
              req: { type: "req", id: "owned-history", method },
              client: null,
              isWebchatConnect: () => false,
              respond,
            });
            // Count synchronous history preparation before optional startup icon work resumes.
            const preparationCopies = cloneSpy.mock.calls.filter(
              ([value]) => asOptionalRecord(value)?.sessionId === scope.sessionId,
            ).length;
            expect(
              parseSpy.mock.calls.some(([value]) => value.includes(skillsSnapshot.prompt)),
            ).toBe(false);
            await pending;
            expect(
              parseSpy.mock.calls.filter(([value]) => value.includes('"sessionId":"history-child"'))
                .length,
            ).toBeLessThanOrEqual(1);
            const [ok, payload, error] = expectDefined(respond.mock.calls[0], "history response");
            expect(error).toBeUndefined();
            expect(ok).toBe(true);
            expect(preparationCopies).toBe(0);
            return expectDefined(asOptionalRecord(payload), "history payload");
          } finally {
            cloneSpy.mockRestore();
            parseSpy.mockRestore();
          }
        };

        const first = await call();
        expect(first).toMatchObject({ thinkingLevel: "high", toolOverrides });
        expect(first.sessionInfo).toMatchObject({ childSessions: [childScope.sessionKey] });
        const responseTools = expectDefined(
          asOptionalRecord(first.toolOverrides),
          "tool overrides",
        );
        const deniedByServer = expectDefined(
          asOptionalRecord(responseTools.mcpToolsDeny),
          "denied tools by server",
        );
        const deniedTools = deniedByServer.synthetic;
        if (!Array.isArray(deniedTools)) {
          throw new Error("expected nested denied tool array");
        }
        deniedTools.push("response-only");
        expect(toolOverrides.mcpToolsDeny.synthetic).toEqual(["blocked"]);
        expect((await call()).toolOverrides).toEqual(toolOverrides);

        await updateSessionEntry(scope, () => ({ thinkingLevel: "low", updatedAt: now + 1 }));
        await updateSessionEntry(childScope, () => ({
          parentSessionKey: "agent:main:other-parent",
          spawnedBy: "agent:main:other-parent",
          updatedAt: now + 1,
        }));
        const fresh = await call();
        expect(fresh).toMatchObject({ thinkingLevel: "low", toolOverrides });
        expect(asOptionalRecord(fresh.sessionInfo)?.childSessions).toBeUndefined();
        expect(first.thinkingLevel).toBe("high");
      });
    },
  );
});

describe("chat history recovery byte budget", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s reuses measured history bytes while preserving the recovery boundary",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:history-bytes",
          sessionId: "history-bytes",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const marker = "history-byte-fixture";
        for (let index = 0; index < 12; index++) {
          await appendTranscriptMessage(scope, {
            message: {
              role: index % 2 === 0 ? "user" : "assistant",
              content: `${marker}-${index}: ${'漢字\n"\\'.repeat(100)}`,
              timestamp: index + 1,
            },
          });
        }
        const context = await createHistoryReadContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async (params: Record<string, unknown> = {}) => {
          const respond = vi.fn<RespondFn>();
          const stringify = JSON.stringify;
          let historyArrayBytes = 0;
          const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
            const result = stringify(...args);
            if (
              Array.isArray(args[0]) &&
              args[0].some((value) => {
                const record = asOptionalRecord(value);
                return (
                  record?.role === "user" || asOptionalRecord(record?.message)?.role === "user"
                );
              }) &&
              typeof result === "string" &&
              result.includes(marker)
            ) {
              historyArrayBytes += Buffer.byteLength(result);
            }
            return result;
          });
          try {
            await handler({
              params: { sessionKey: scope.sessionKey, ...params },
              context,
              req: { type: "req", id: "history-bytes", method },
              client: null,
              isWebchatConnect: () => false,
              respond,
            });
          } finally {
            serialization.mockRestore();
          }
          expect(respond).toHaveBeenCalledTimes(1);
          const [ok, payload, error] = expectDefined(respond.mock.calls[0], "history response");
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          expect(historyArrayBytes).toBe(0);
          return expectDefined(asOptionalRecord(payload), "history payload");
        };
        const inactive = await call();
        expect(inactive.messages).toHaveLength(12);
        expect(inactive.inFlightRun).toBeUndefined();
        const historyJson = JSON.stringify(inactive.messages);
        const registration = registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          runId: "run-history-bytes",
          ...scope,
          now: 1_000,
          timeoutMs: 60_000,
        });
        const run = context.chatRunState.getOrCreate("run-history-bytes");
        run.buffer = "partial reply ".repeat(1_000);
        run.planSnapshot = { steps: [{ step: "Read history", status: "in_progress" }] };
        const expected = {
          runId: "run-history-bytes",
          text: run.buffer,
          startedAt: 1_000,
          plan: run.planSnapshot,
        };
        const exactBytes =
          Buffer.byteLength(historyJson) + Buffer.byteLength(JSON.stringify(expected));
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
        try {
          const bounded = await call({ maxBytes: exactBytes - 1 });
          expect(bounded.messages).toEqual(inactive.messages);
          expect(bounded.inFlightRun).toEqual({ ...expected, text: "" });
          const exact = await call({ maxBytes: exactBytes });
          expect(exact.messages).toEqual(inactive.messages);
          expect(exact.inFlightRun).toEqual(expected);
          expect(
            Buffer.byteLength(JSON.stringify(exact.messages)) +
              Buffer.byteLength(JSON.stringify(exact.inFlightRun)),
          ).toBe(exactBytes);
          const delta = await call({ cursor: exact.deltaCursor, maxBytes: exactBytes });
          expect(delta).toMatchObject({ kind: "delta", messages: [], inFlightRun: expected });
          await appendTranscriptMessage(scope, {
            eventId: "delta-user",
            message: {
              role: "user",
              content: `${marker}: ${'漢字\n"\\🤖'.repeat(100)}`,
              timestamp: 13,
            },
          });
          await appendTranscriptMessage(scope, {
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
            const page = await call({
              cursor: exact.deltaCursor,
              maxBytes: deltaBytes + extraBytes,
            });
            expect(page.messages).toEqual(appended.messages);
            expect(page.activity).toEqual(appended.activity);
            expect(page.inFlightRun).toEqual(
              extraBytes === 0 ? expected : { ...expected, text: "" },
            );
            expect(page).not.toHaveProperty("messagesBytes");
            expect(page).not.toHaveProperty("activityBytes");
          }
          expect(delta).not.toHaveProperty("messagesBytes");
          expect(delta).not.toHaveProperty("activityBytes");
          expect(JSON.stringify(inactive.messages)).toBe(historyJson);
        } finally {
          clock.mockRestore();
          registration.cleanup();
          context.chatRunState.clearRun("run-history-bytes");
        }
        const completed = await call();
        expect(completed.messages).toHaveLength(14);
        if (!Array.isArray(completed.messages)) {
          throw new Error("Expected completed history messages");
        }
        expect(completed.messages.slice(0, 12)).toEqual(inactive.messages);
        expect(completed.inFlightRun).toBeUndefined();
      });
    },
  );
});

describe("chat metadata ownership", () => {
  it("previews a retained personal account with read scope without changing its cleared default", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { owner, authProfileId, metadata, readChatMetadata, request } =
        createPersonalMetadataFixture();
      clearUserProfileAuthLink({ profileId: owner.id, provider: "openai" });
      const before = readUserModelAuthProfile(authProfileId);

      const respond = await request({ agentId: "main", authProfileId });

      expect(respond).toHaveBeenCalledWith(true, metadata);
      expect(readChatMetadata).toHaveBeenCalledWith({
        agentId: "main",
        requesterProfileId: owner.id,
        isCurrent: expect.any(Function),
        assertCurrent: expect.any(Function),
        draftAccountSelection: expect.objectContaining({
          owner: owner.id,
          authProfileId,
          assertCurrent: expect.any(Function),
        }),
      });
      expect(listUserProfileAuthLinks(owner.id)).toEqual([]);
      expect(readUserModelAuthProfile(authProfileId)).toEqual(before);
    });
  });

  it.each([
    "foreign admin",
    "unidentified admin",
    "anonymous",
    "synthetic owner",
    "forged locator",
  ] as const)(
    "rejects a personal draft preview from %s before projecting credentials",
    async (caller) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { owner, client, authProfileId, readChatMetadata, request } =
          createPersonalMetadataFixture();
        client.connect.scopes = ["operator.admin"];
        let requestedProfile = authProfileId;
        if (caller === "foreign admin") {
          const other = ensureProfileForEmail("metadata-other@example.test");
          client.authenticatedUserProfile = {
            profileId: other.id,
            displayName: other.displayName,
            hasAvatar: false,
            updatedAt: other.updatedAt,
          };
        } else if (caller === "unidentified admin") {
          delete client.authenticatedUserProfile;
        } else if (caller === "synthetic owner") {
          client.internal = { syntheticClient: true };
        } else if (caller === "forged locator") {
          requestedProfile = `personal:${owner.id}:${randomUUID()}`;
        }

        const respond = await request(
          { agentId: "main", authProfileId: requestedProfile },
          caller === "anonymous" ? { client: null } : {},
        );

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(readChatMetadata).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["disconnect", "role loss", "abort"] as const)(
    "rejects a personal draft preview after %s during the metadata read",
    async (loss) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { client, clients, authProfileId, config, metadata, readChatMetadata, request } =
          createPersonalMetadataFixture();
        const entered = createDeferred();
        const release = createDeferred();
        const abort = new AbortController();
        readChatMetadata.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return metadata;
        });
        const pending = request({ agentId: "main", authProfileId }, { signal: abort.signal });
        try {
          await Promise.race([entered.promise, pending]);
          expect(readChatMetadata).toHaveBeenCalledOnce();
          if (loss === "disconnect") {
            clients.delete(client);
          } else if (loss === "role loss") {
            config.gateway.roles.definitions.reader.scopes = [];
          } else {
            abort.abort();
          }
        } finally {
          release.resolve();
          await pending;
        }
        const respond = await pending;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      });
    },
  );

  it("reads the persisted session profile without contaminating neutral agent metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:locked";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "locked",
          updatedAt: 1,
          authProfileOverride: "test:locked",
          authProfileOverrideSource: "user",
        },
      );
      const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => ({
        commands: [],
        models: [],
        swarmEnabled: false,
      }));
      const respond = vi.fn();
      const handler = expectDefined(chatHistoryHandlers["chat.metadata"], "metadata handler");
      const context = createDirectChatContext({ readChatMetadata });
      for (const params of [{ agentId: "   ", sessionKey }, { agentId: "main" }]) {
        await handler({
          params,
          context,
          respond,
          req: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
      }
      expect(readChatMetadata.mock.calls).toEqual([
        [
          expect.objectContaining({
            agentId: "main",
            sessionKey,
            isCurrent: expect.any(Function),
            sessionEntry: expect.objectContaining({
              authProfileOverride: "test:locked",
              authProfileOverrideSource: "user",
            }),
          }),
        ],
        [
          {
            agentId: "main",
            requesterProfileId: undefined,
            isCurrent: expect.any(Function),
            assertCurrent: expect.any(Function),
          },
        ],
      ]);
      const neutral = expectDefined(readChatMetadata.mock.calls[1]?.[0], "neutral metadata read");
      expect(neutral.isCurrent?.()).toBe(true);
      expectDefined(neutral.assertCurrent, "neutral metadata authority check")();
      expect(respond).toHaveBeenCalledTimes(2);
      readChatMetadata.mockClear();
      await handler({
        params: { agentId: "other", sessionKey },
        context,
        respond,
        req: {} as never,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(readChatMetadata).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    });
  });

  it("returns a typed selection error for an ownerless explicit fleet", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    };
    const respond = vi.fn();
    const readChatMetadata = vi.fn();

    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      'chatHistoryHandlers["chat.metadata"] test invariant',
    )({
      params: {},
      respond: respond as unknown as RespondFn,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => config,
        readChatMetadata,
      } as unknown as GatewayRequestContext,
    });

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
});
