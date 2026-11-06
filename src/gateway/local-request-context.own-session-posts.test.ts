import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sessionManagerReadInitialContext } from "../agents/sessions/session-manager-current-turn.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../agents/tool-search.js";
import { withGatewayPersonalToolUser } from "../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { createSessionStatusTool } from "../agents/tools/session-status-tool.js";
import { resolveSessionToolContext } from "../agents/tools/sessions-helpers.js";
import { createSessionsHistoryTool } from "../agents/tools/sessions-history-tool.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import { resolveSessionReference } from "../agents/tools/sessions-resolution.js";
import { createSessionsSearchTool } from "../agents/tools/sessions-search-tool.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { mockSessionStatusModelDependencies } from "./local-request-context.session-status.test-support.js";
import {
  REQUESTER,
  PARTICIPANT_SHARED,
  withDelayedSessionToolsSteering,
  PARTICIPANT_DRAFT,
  PARTICIPANT_DRAFT_ID,
  withParticipantSessionToolsFixture,
  seedSessionToolsFixtureSession,
  sessionToolsStorePath,
  sessionToolsContext,
  withSessionToolsFixture,
  drainSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import * as chatInjection from "./server-methods/chat-inject.js";
import { roleClient } from "./session-sharing.test-utils.js";
import * as sessionStoreWorker from "./session-utils-store-worker.js";

let runtimeSetup: Promise<unknown>[] = [];
beforeAll(() => {
  // Prepare real handler imports outside the Gateway request deadlines.
  runtimeSetup = [
    import("./server-methods/chat.js"),
    import("./server-methods/sessions-create.js"),
    import("./server-methods/sessions-delete.js"),
    import("./server-methods/sessions-mutations.js"),
    import("./server-methods/sessions-read.js"),
    import("./server-methods/sessions.runtime.js"),
  ];
  return Promise.all(runtimeSetup);
});
afterAll(async () => {
  await Promise.allSettled(runtimeSetup);
});
afterEach(drainSessionToolsFixture);

it("discovers and reads an independent session created by the requesting human", async () => {
  await withParticipantSessionToolsFixture(
    async ({ cfg, turn, alice, bob }) => {
      const options = {
        agentSessionKey: REQUESTER,
        requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
        sandboxed: true,
      };
      const listed = await createSessionsListTool(options).execute("own-created-list", {
        relationship: "created",
        user: alice.profileId,
      });
      expect(listed.details).toMatchObject({
        sessions: expect.arrayContaining([expect.objectContaining({ key: PARTICIPANT_DRAFT })]),
      });
      const history = createSessionsHistoryTool(options);
      await expect(
        history.execute("own-created-history", {
          sessionKey: PARTICIPANT_DRAFT,
          user: alice.profileId,
        }),
      ).resolves.toMatchObject({
        details: {
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        },
      });
      const foreign = "agent:main:dashboard:foreign-created";
      await seedSessionToolsFixtureSession({
        sessionKey: foreign,
        sessionId: "foreign-created-id",
        creatorId: bob.profileId,
        visibility: "draft",
      });
      await expect(
        history.execute("foreign-created-history", {
          sessionKey: foreign,
          user: alice.profileId,
        }),
      ).resolves.toMatchObject({ details: { status: "forbidden" } });
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({
        catalogRef,
        tools: [createSessionsSendTool(options)],
        hookContext: { runId: "post-denials" },
      });
      const postCatalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
      for (const target of [foreign, "agent:main:dashboard:missing-post-target"]) {
        await expect(
          postCatalog.callValue(
            "sessions_send",
            {
              sessionKey: target,
              user: alice.profileId,
              mode: "post",
              message: "Foreign session must not be writable",
            },
            { parentToolCallId: "post-denials" },
          ),
        ).resolves.toMatchObject({
          status: "forbidden",
          runId: expect.any(String),
          error: expect.any(String),
        });
      }
      expect(
        JSON.stringify(
          await loadTranscriptEvents({
            agentId: "main",
            sessionKey: foreign,
            sessionId: "foreign-created-id",
          }),
        ),
      ).not.toContain("Foreign session must not be writable");
      for (const filter of [{ creatorId: bob.profileId }, { ownerId: bob.profileId }]) {
        const filtered = await createSessionsListTool(options).execute("foreign-selector-list", {
          ...filter,
          user: alice.profileId,
        });
        expect(JSON.stringify(filtered.details)).not.toContain(foreign);
      }
      mockSessionStatusModelDependencies();
      const status = createSessionStatusTool(options);
      await expect(
        status.execute("own-created-status", {
          sessionKey: PARTICIPANT_DRAFT,
          user: alice.profileId,
        }),
      ).resolves.toMatchObject({ details: { sessionKey: PARTICIPANT_DRAFT } });
      await expect(
        status.execute("no-model-mutation", {
          sessionKey: PARTICIPANT_DRAFT,
          user: alice.profileId,
          model: "default",
        }),
      ).rejects.toThrow(/visibility is restricted/i);
      await expect(
        createSessionsTool(options).execute("no-session-mutation", {
          action: "patch",
          sessionKey: PARTICIPANT_DRAFT,
          user: alice.profileId,
          label: "Do not rename",
        }),
      ).rejects.toThrow(/visibility is restricted/i);
      const search = createSessionsSearchTool(options);
      for (const scoped of [true, false]) {
        await expect(
          search.execute("own-created-search", {
            query: "distinctive",
            user: alice.profileId,
            ...(scoped ? { sessionKey: PARTICIPANT_DRAFT } : {}),
          }),
        ).resolves.toMatchObject({
          details: {
            results: expect.arrayContaining([
              expect.objectContaining({ sessionKey: PARTICIPANT_DRAFT }),
            ]),
          },
        });
      }
      const post = createSessionsSendTool(options);
      const recipient = {
        agentId: "main",
        sessionKey: PARTICIPANT_DRAFT,
        sessionId: PARTICIPANT_DRAFT_ID,
        storePath: sessionToolsStorePath(cfg),
      };
      const activeManager = await SessionManager.openAsync(recipient, "/workspace");
      const admitted = await activeManager.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "Active recipient user turn",
        timestamp: Date.now(),
      });
      const admission = {
        ...expectDefined(admitted.anchor, "committed recipient input anchor"),
        role: "user" as const,
        logicalTurnId: "passive-post-active-recipient",
      };
      const readActivePrompt = () =>
        runWithSessionTranscriptReadFence(admission, async () => {
          const reader = await SessionManager.openAsync(recipient, "/workspace");
          return reader[sessionManagerReadInitialContext]();
        });
      const currentContext = await readActivePrompt();
      const args = {
        sessionKey: PARTICIPANT_DRAFT,
        user: alice.profileId,
        mode: "post",
        message: "Passive session marker",
        idempotencyKey: "passive-session-marker",
      };
      const first = await withOwnedSessionTranscriptWrites(
        {
          sessionKey: REQUESTER,
          sessionTarget: { sessionKey: REQUESTER, sessionId: "requester-turn", agentId: "main" },
          assertCommitAllowed: () => {},
          withTranscriptWrite: async (run) => run(),
        },
        () => post.execute("passive-post", args),
      );
      expect(first.details).toMatchObject({
        status: "posted",
        sessionKey: PARTICIPANT_DRAFT,
        sourceSessionKey: REQUESTER,
        replayed: false,
      });
      // Reacquire from SQLite under the active input fence, not a retained in-memory array.
      expect(await readActivePrompt()).toEqual(currentContext);
      const replay = await post.execute("passive-post-retry", args);
      if (!isRecord(first.details)) {
        throw new Error("Expected post receipt");
      }
      expect(replay.details).toMatchObject({ ...first.details, replayed: true });
      await runWithSessionTranscriptReadFence(admission, () =>
        activeManager.appendMessageAsync({
          role: "assistant",
          content: [{ type: "text", text: "Existing turn finished" }],
          api: "openai-responses",
          provider: "openai",
          model: "test-model",
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp: Date.now(),
        }),
      );
      const nextManager = await SessionManager.openAsync(recipient, "/workspace");
      expect(JSON.stringify(nextManager.buildSessionContext())).toContain("Passive session marker");
      const readBack = await history.execute("posted-history", {
        sessionKey: PARTICIPANT_DRAFT,
        user: alice.profileId,
      });
      expect(readBack.details).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: "Alice's distinctive draft marker" }),
          expect.objectContaining({
            role: "assistant",
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: REQUESTER,
              sourceTool: "sessions_send",
            },
          }),
        ]),
      });
      expect(JSON.stringify(readBack.details).match(/Passive session marker/g)).toHaveLength(1);
      await withDelayedSessionToolsSteering(cfg, async (receiver) => {
        expect(receiver.pendingCount()).toBe(0);
        await expect(
          post.execute("busy-passive-post", {
            sessionKey: PARTICIPANT_SHARED,
            user: alice.profileId,
            mode: "post",
            message: "Busy passive marker",
            idempotencyKey: "busy-passive-marker",
          }),
        ).resolves.toMatchObject({ details: { status: "posted" } });
        expect(receiver.pendingCount()).toBe(0);
      });
      const busyReadBack = await history.execute("busy-post-history", {
        sessionKey: PARTICIPANT_SHARED,
        user: alice.profileId,
      });
      expect(JSON.stringify(busyReadBack.details)).toContain("Busy passive marker");
      await expect(
        post.execute("still-no-dispatch", {
          sessionKey: PARTICIPANT_DRAFT,
          user: alice.profileId,
          message: "Do not start a turn",
        }),
      ).resolves.toMatchObject({ details: { status: "forbidden" } });
    },
    { visibility: "tree" },
  );
});

type ExplicitPolicyCase = NonNullable<Parameters<typeof withParticipantSessionToolsFixture>[1]> & {
  name: string;
  targetAgent: string;
};

it.each<ExplicitPolicyCase>([
  { name: "self", visibility: "self", targetAgent: "main", agentToAgent: undefined },
  {
    name: "A2A disabled",
    visibility: "all",
    targetAgent: "other",
    agentToAgent: { enabled: false },
  },
  {
    name: "A2A allow denial",
    visibility: "all",
    targetAgent: "other",
    agentToAgent: { enabled: true, allow: ["unrelated"] },
  },
  { name: "agent-only", visibility: "agent", targetAgent: "other", agentToAgent: undefined },
])(
  "preserves explicit $name policy for creator reads and posts",
  async ({ visibility, targetAgent, agentToAgent }) => {
    await withParticipantSessionToolsFixture(
      async ({ turn, alice }) => {
        const key = "agent:" + targetAgent + ":dashboard:own-policy-target";
        await seedSessionToolsFixtureSession({
          agentId: targetAgent,
          sessionKey: key,
          sessionId: "own-policy-target-id",
          creatorId: alice.profileId,
          visibility: "draft",
        });
        const options = {
          agentSessionKey: REQUESTER,
          requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
        };
        const catalogRef = createToolSearchCatalogRef();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools: [createSessionsSendTool(options)],
          hookContext: { runId: "policy-post" },
        });
        const postCatalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
        const post = await postCatalog.callValue(
          "sessions_send",
          {
            sessionKey: key,
            user: alice.profileId,
            mode: "post",
            message: "Must not bypass explicit policy",
          },
          { parentToolCallId: "policy-post" },
        );
        const list = await createSessionsListTool(options).execute("policy-list", {
          relationship: "created",
          user: alice.profileId,
        });
        const history = await createSessionsHistoryTool(options).execute("policy-history", {
          sessionKey: key,
          user: alice.profileId,
        });
        expect({
          post,
          listed: JSON.stringify(list.details).includes(key),
          history: history.details,
        }).toMatchObject({
          post: { status: "forbidden", runId: expect.any(String), error: expect.any(String) },
          listed: false,
          history: { status: "forbidden" },
        });
        expect(
          JSON.stringify(
            await loadTranscriptEvents({
              agentId: targetAgent,
              sessionKey: key,
              sessionId: "own-policy-target-id",
            }),
          ),
        ).not.toContain("Must not bypass explicit policy");
      },
      { visibility, agentToAgent },
    );
  },
);

it("does not expose out-of-tool-scope candidates from ambiguous session IDs", async () => {
  await withParticipantSessionToolsFixture(
    async ({ alice, bob }) => {
      const ownKey = "agent:main:dashboard:resolve-own";
      const foreignKey = "agent:other:dashboard:foreign-view-candidate";
      const sharedId = "9e7322bd-99d9-40dd-8d93-1b6e92019e11";
      await seedSessionToolsFixtureSession({
        agentId: "main",
        sessionKey: ownKey,
        sessionId: sharedId,
        creatorId: alice.profileId,
        visibility: "draft",
      });
      await seedSessionToolsFixtureSession({
        agentId: "other",
        sessionKey: foreignKey,
        sessionId: sharedId,
        creatorId: bob.profileId,
        visibility: "shared",
      });
      // The human's Gateway role can view both candidates; the agent's tree scope cannot.
      let resolveError: unknown;
      try {
        await callAgentToolGatewayRequest({
          method: "sessions.resolve",
          params: { sessionId: sharedId, includeGlobal: true, includeUnknown: true },
        });
      } catch (error) {
        resolveError = error;
      }
      if (!(resolveError instanceof Error)) {
        throw new Error("Expected the Gateway ambiguity error");
      }
      expect(resolveError.message).toContain("Multiple sessions found");
      expect(resolveError.message).toContain(ownKey);
      expect(resolveError.message).toContain(foreignKey);
      const history = createSessionsHistoryTool({
        agentSessionKey: REQUESTER,
        sandboxed: true,
      });
      for (const input of [sharedId, sharedId.slice(0, 8)]) {
        const result = await history.execute("ambiguous-private-candidates", {
          sessionKey: input,
          user: alice.profileId,
        });
        expect(JSON.stringify(result.details)).not.toContain(foreignKey);
        expect(JSON.stringify(result.details)).not.toContain("candidates");
      }
      await expect(
        history.execute("foreign-candidate-direct", {
          sessionKey: foreignKey,
          user: alice.profileId,
        }),
      ).resolves.toMatchObject({ details: { status: "forbidden" } });
    },
    { visibility: "tree" },
  );
});

it("does not turn an unscoped ID lookup into spawned-session ownership", async () => {
  await withParticipantSessionToolsFixture(
    async ({ alice, bob }) => {
      const ownKey = "agent:main:dashboard:own-unambiguous-id";
      const foreignKey = "agent:main:dashboard:foreign-unambiguous-id";
      const ownId = "0e81472d-6883-44ce-bc60-53f793ab91e0";
      const foreignId = "fc95e3ab-3f52-4f76-8ab6-d1464daebf84";
      for (const [sessionKey, sessionId, creatorId, visibility, marker] of [
        [ownKey, ownId, alice.profileId, "draft", "Own ID context marker"],
        [foreignKey, foreignId, bob.profileId, "shared", "Foreign ID context must remain hidden"],
      ] as const) {
        await seedSessionToolsFixtureSession({
          agentId: "main",
          sessionKey,
          sessionId,
          creatorId,
          visibility,
        });
        await appendTranscriptMessage(
          { agentId: "main", sessionKey, sessionId },
          { message: { role: "user", content: marker } },
        );
      }
      const history = createSessionsHistoryTool({
        agentSessionKey: REQUESTER,
        sandboxed: true,
      });
      await expect(
        history.execute("own-id-read", { sessionKey: ownId, user: alice.profileId }),
      ).resolves.toMatchObject({
        details: { messages: [expect.objectContaining({ content: "Own ID context marker" })] },
      });
      const foreign = await history.execute("foreign-id-read", {
        sessionKey: foreignId,
        user: alice.profileId,
      });
      expect(foreign.details).toMatchObject({ status: "forbidden" });
      expect(JSON.stringify(foreign.details)).not.toContain(
        "Foreign ID context must remain hidden",
      );
      const metadataOutageHistory = createSessionsHistoryTool({
        agentSessionKey: REQUESTER,
        sandboxed: true,
        callGateway: async <T>(
          request: Parameters<typeof callAgentToolGatewayRequest>[0],
        ): Promise<T> => {
          if (request.method === "sessions.describe") {
            throw new Error("Synthetic descriptor lookup outage");
          }
          return callAgentToolGatewayRequest<T>(request);
        },
      });
      await expect(
        metadataOutageHistory.execute("foreign-id-during-descriptor-outage", {
          sessionKey: foreignId,
          user: alice.profileId,
        }),
      ).resolves.toMatchObject({ details: { status: "forbidden" } });
      const context = resolveSessionToolContext({ agentSessionKey: REQUESTER, sandboxed: true });
      const resolved = await withGatewayPersonalToolUser(alice.profileId, () =>
        resolveSessionReference({
          action: "history",
          sessionKey: foreignId,
          alias: context.alias,
          mainKey: context.mainKey,
          requesterInternalKey: REQUESTER,
          restrictToSpawned: context.restrictToSpawned,
        }),
      );
      expect(resolved).toMatchObject({ ok: true, key: foreignKey, requesterOwned: false });
    },
    { visibility: "tree" },
  );
});

it("keeps reads allowed while enforcing explicit outbound post denial", async () => {
  await withParticipantSessionToolsFixture(
    async ({ turn, alice }) => {
      const key = "agent:other:dashboard:outbound-post-denied";
      const sessionId = "5f9f29bf-e59d-4a30-8a97-51c6f3b96c78";
      await seedSessionToolsFixtureSession({
        agentId: "other",
        sessionKey: key,
        sessionId,
        creatorId: alice.profileId,
        visibility: "draft",
      });
      await appendTranscriptMessage(
        { agentId: "other", sessionKey: key, sessionId },
        { message: { role: "user", content: "Readable despite outbound denial" } },
      );
      const options = {
        agentSessionKey: REQUESTER,
        requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
      };
      await expect(
        createSessionsHistoryTool(options).execute("outbound-read", {
          sessionKey: key,
          user: alice.profileId,
        }),
      ).resolves.toMatchObject({
        details: {
          messages: [expect.objectContaining({ content: "Readable despite outbound denial" })],
        },
      });
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({
        catalogRef,
        tools: [createSessionsSendTool(options)],
        hookContext: { runId: "outbound-post" },
      });
      const postCatalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
      await expect(
        postCatalog.callValue(
          "sessions_send",
          {
            sessionKey: key,
            user: alice.profileId,
            mode: "post",
            message: "Must respect explicit outbound denial",
          },
          { parentToolCallId: "outbound-post" },
        ),
      ).resolves.toMatchObject({
        status: "forbidden",
        runId: expect.any(String),
        error: expect.any(String),
      });
      expect(
        JSON.stringify(
          await loadTranscriptEvents({ agentId: "other", sessionKey: key, sessionId }),
        ),
      ).not.toContain("Must respect explicit outbound denial");
    },
    { visibility: "all", mainSend: [] },
  );
});

it.each(["sender send list", "global A2A enablement", "global A2A allow list"])(
  "rejects a cross-agent post when %s is revoked during injection",
  async (policy) => {
    await withParticipantSessionToolsFixture(
      async ({ cfg, turn, alice }) => {
        const key = "agent:other:dashboard:revoked-post";
        const sessionId = "revoked-post-session";
        const marker = "Must not persist after revocation";
        await seedSessionToolsFixtureSession({
          agentId: "other",
          sessionKey: key,
          sessionId,
          creatorId: alice.profileId,
          visibility: "draft",
        });
        const options = {
          agentSessionKey: REQUESTER,
          requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
        };
        const inject = chatInjection.injectGatewayAssistantMessage;
        const load = sessionStoreWorker.loadGatewaySessionEntryReadOnlyInWorker;
        let boundaryReached = false;
        const readSpy = vi.spyOn(sessionStoreWorker, "loadGatewaySessionEntryReadOnlyInWorker");
        const injectionSpy = vi
          .spyOn(chatInjection, "injectGatewayAssistantMessage")
          .mockImplementationOnce(async (...args) => {
            readSpy.mockImplementationOnce(async (params) => {
              expect(params.key).toBe(key);
              const target = await load(params);
              boundaryReached = true;
              if (policy === "sender send list") {
                cfg.agents!.entries!.main!.tools!.agentToAgent!.send = [];
              } else if (policy === "global A2A enablement") {
                cfg.tools!.agentToAgent!.enabled = false;
              } else {
                cfg.tools!.agentToAgent!.allow = ["main"];
              }
              setRuntimeConfigSnapshot({ ...cfg });
              return target;
            });
            return inject(...args);
          });
        try {
          await expect(
            createSessionsSendTool(options).execute("revoked-post", {
              sessionKey: key,
              user: alice.profileId,
              mode: "post",
              message: marker,
            }),
          ).rejects.toThrow(/tools\.agentToAgent/);
        } finally {
          injectionSpy.mockRestore();
          readSpy.mockRestore();
        }
        expect(boundaryReached).toBe(true);
        const messages = await loadTranscriptEvents({
          agentId: "other",
          sessionKey: key,
          sessionId,
        });
        expect(JSON.stringify(messages)).not.toContain(marker);
      },
      { visibility: "all", mainSend: ["other"], agentToAgent: { enabled: true } },
    );
  },
);

it("rejects a same-agent post when requester visibility is revoked during injection", async () => {
  await withParticipantSessionToolsFixture(
    async ({ cfg, turn, alice }) => {
      const key = "agent:main:dashboard:visibility-revoked-post";
      for (const [sessionKey, sessionId] of [
        [REQUESTER, "session-tools-requester-id"],
        [key, "visibility-revoked-post-session"],
      ] as const) {
        await seedSessionToolsFixtureSession({
          sessionKey,
          sessionId,
          creatorId: alice.profileId,
          visibility: "draft",
        });
      }
      const options = {
        agentSessionKey: REQUESTER,
        requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
      };
      const inject = chatInjection.injectGatewayAssistantMessage;
      const load = sessionStoreWorker.loadGatewaySessionEntryReadOnlyInWorker;
      let boundaryReached = false;
      const readSpy = vi.spyOn(sessionStoreWorker, "loadGatewaySessionEntryReadOnlyInWorker");
      const injectionSpy = vi
        .spyOn(chatInjection, "injectGatewayAssistantMessage")
        .mockImplementationOnce(async (...args) => {
          readSpy.mockImplementationOnce(async (params) => {
            expect(params.key).toBe(key);
            const target = await load(params);
            boundaryReached = true;
            cfg.tools!.sessions!.visibility = "self";
            setRuntimeConfigSnapshot({ ...cfg });
            return target;
          });
          return inject(...args);
        });
      try {
        await expect(
          createSessionsSendTool(options).execute("visibility-revoked-post", {
            sessionKey: key,
            user: alice.profileId,
            mode: "post",
            message: "Must not persist after visibility revocation",
          }),
        ).rejects.toThrow(/tools\.sessions\.visibility/);
      } finally {
        injectionSpy.mockRestore();
        readSpy.mockRestore();
      }
      expect(boundaryReached).toBe(true);
      const messages = await loadTranscriptEvents({
        agentId: "main",
        sessionKey: key,
        sessionId: "visibility-revoked-post-session",
      });
      expect(JSON.stringify(messages)).not.toContain(
        "Must not persist after visibility revocation",
      );
    },
    { visibility: "all" },
  );
});

it.each([false, true])(
  "revalidates destination sharing after RPC authorization (revoked: %s)",
  async (revoke) => {
    await withSessionToolsFixture(async () => {
      const key = "agent:main:dashboard:sharing-revoked-post";
      const sessionId = "sharing-revoked-post-session";
      const marker = "Post admitted before destination sharing changed";
      // Isolated setup owns the destination; the subject is a different, non-admin writer.
      await seedSessionToolsFixtureSession({ sessionKey: key, sessionId });
      const client = roleClient("write", "passive-post-subject");
      expect(client.connect.scopes).toEqual(["operator.read", "operator.write"]);
      const inject = chatInjection.injectGatewayAssistantMessage;
      const load = sessionStoreWorker.loadGatewaySessionEntryReadOnlyInWorker;
      let boundaryReached = false;
      const readSpy = vi.spyOn(sessionStoreWorker, "loadGatewaySessionEntryReadOnlyInWorker");
      const injectionSpy = vi
        .spyOn(chatInjection, "injectGatewayAssistantMessage")
        .mockImplementationOnce(async (...args) => {
          // The router has already prepared target authorization. Keep the real injection,
          // but withdraw sharing while its existing destination read is awaited.
          readSpy.mockImplementationOnce(async (params) => {
            expect(params.key).toBe(key);
            const target = await load(params);
            boundaryReached = true;
            if (revoke) {
              await seedSessionToolsFixtureSession({
                sessionKey: key,
                sessionId,
                visibility: "draft",
              });
            }
            return target;
          });
          return inject(...args);
        });
      const respond = vi.fn();
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "sharing-revoked-post",
            method: "sessions.post",
            params: {
              sessionKey: key,
              expectedSessionId: sessionId,
              message: marker,
              idempotencyKey: "sharing-revoked-post",
            },
          },
          context: sessionToolsContext(),
          client,
          isWebchatConnect: () => false,
          respond,
        });
      } finally {
        injectionSpy.mockRestore();
        readSpy.mockRestore();
      }
      expect(boundaryReached, JSON.stringify(respond.mock.calls)).toBe(true);
      const messages = await loadTranscriptEvents({ agentId: "main", sessionKey: key, sessionId });
      expect({
        success: respond.mock.calls[0]?.[0],
        durableMarker: JSON.stringify(messages).includes(marker),
      }).toEqual({ success: !revoke, durableMarker: !revoke });
    });
  },
);
