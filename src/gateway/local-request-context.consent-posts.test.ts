import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../agents/tool-search.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  REQUESTER,
  PARTICIPANT_DRAFT,
  PARTICIPANT_DRAFT_ID,
  seedSessionToolsEntry,
  seedSessionToolsFixtureSession,
  withParticipantSessionToolsFixture,
  sessionToolsContext,
  drainSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { QuestionManager } from "./question-manager.js";
import { handleGatewayRequest } from "./server-methods.js";
import * as chatInjection from "./server-methods/chat-inject.js";
import { createQuestionHandlers } from "./server-methods/question.js";
import { createSecretStoreWriteService } from "./server-methods/secrets.js";
import { roleClient } from "./session-sharing.test-utils.js";
import * as sessionStoreWorker from "./session-utils-store-worker.js";

let runtimeSetup: Promise<unknown>[] = [];
beforeAll(() => {
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

it.each(["send", "receive"] as const)(
  "enforces %s Never consent for passive posts",
  async (direction) => {
    await withParticipantSessionToolsFixture(
      async ({ turn, alice }) => {
        const target = PARTICIPANT_DRAFT;
        await seedSessionToolsEntry(
          direction === "send" ? REQUESTER : target,
          direction === "send" ? "session-tools-requester-id" : PARTICIPANT_DRAFT_ID,
          { communication: { [direction]: "never" } },
        );
        const catalogRef = createToolSearchCatalogRef();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools: [
            createSessionsSendTool({
              agentSessionKey: REQUESTER,
              requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
            }),
          ],
          hookContext: { runId: "post-consent" },
        });
        const catalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
        const error = `Session communication ${direction} is disabled for ${direction === "send" ? REQUESTER : target}.`;
        for (const mode of [undefined, "post"]) {
          await expect(
            catalog.callValue(
              "sessions_send",
              {
                sessionKey: target,
                user: alice.profileId,
                message: "Never consent must not persist",
                timeoutSeconds: 0,
                ...(mode ? { mode } : {}),
              },
              { parentToolCallId: "post-consent" },
            ),
          ).resolves.toMatchObject({ status: "forbidden", error });
          expect(
            JSON.stringify(
              await loadTranscriptEvents({
                agentId: "main",
                sessionKey: target,
                sessionId: PARTICIPANT_DRAFT_ID,
              }),
            ),
          ).not.toContain("Never consent must not persist");
        }
      },
      { visibility: "all" },
    );
  },
);

it.each([
  { direction: "send", decision: "Deny", posted: false },
  { direction: "send", decision: "Allow once", posted: true },
  { direction: "receive", decision: "Deny", posted: false },
  { direction: "receive", decision: "Allow once", posted: true },
] as const)(
  "requires explicit $direction Ask decision $decision before posting",
  async ({ direction, decision, posted }) => {
    const requester = { sessionKey: "agent:main:dashboard:ask-source", sessionId: "ask-source-id" };
    await withParticipantSessionToolsFixture(
      async ({ turn, alice }) => {
        if (direction === "send") {
          await seedSessionToolsEntry(requester.sessionKey, requester.sessionId, {
            communication: { send: "ask" },
          });
        }
        if (direction === "receive") {
          await seedSessionToolsEntry(PARTICIPANT_DRAFT, PARTICIPANT_DRAFT_ID, {
            communication: { receive: "ask" },
          });
        }
        const context = sessionToolsContext();
        const previousManager = context.questionManager;
        const scheduler = createTestGatewayScheduler();
        const manager = new QuestionManager(scheduler);
        context.questionManager = manager;
        const handlers = createQuestionHandlers(
          manager,
          createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
          scheduler,
        );
        const catalogRef = createToolSearchCatalogRef();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools: [
            createSessionsSendTool({
              agentSessionKey: requester.sessionKey,
              requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
            }),
          ],
          hookContext: { runId: "ask-post" },
        });
        const catalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
        const marker = "Ask consent must precede this note";
        const pending = catalog.callValue(
          "sessions_send",
          { sessionKey: PARTICIPANT_DRAFT, user: alice.profileId, mode: "post", message: marker },
          { parentToolCallId: "ask-post" },
        );
        let outcome: unknown;
        void pending.then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          },
        );
        try {
          await vi.waitFor(() => expect(manager.list(), JSON.stringify(outcome)).toHaveLength(1), {
            timeout: 10000,
          });
          const question = expectDefined(manager.list()[0], "pending real communication question");
          expect(question.status).toBe("pending");
          expect(outcome).toBeUndefined();
          expect(
            JSON.stringify(
              await loadTranscriptEvents({
                agentId: "main",
                sessionKey: PARTICIPANT_DRAFT,
                sessionId: PARTICIPANT_DRAFT_ID,
              }),
            ),
          ).not.toContain(marker);
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "resolve-post-consent",
              method: "question.resolve",
              params: { id: question.id, answers: { answers: { communication: [decision] } } },
            },
            context,
            client: roleClient("write", "alice-participant"),
            isWebchatConnect: () => false,
            respond,
            extraHandlers: handlers,
          });
          expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls)).toBe(true);
          await expect(pending).resolves.toMatchObject({ status: posted ? "posted" : "forbidden" });
          expect(
            JSON.stringify(
              await loadTranscriptEvents({
                agentId: "main",
                sessionKey: PARTICIPANT_DRAFT,
                sessionId: PARTICIPANT_DRAFT_ID,
              }),
            ).includes(marker),
          ).toBe(posted);
        } finally {
          manager.close();
          await Promise.allSettled([pending]);
          await manager.drain();
          await scheduler.stop();
          context.questionManager = previousManager;
        }
      },
      { visibility: "all", requester },
    );
  },
);

it("preserves passive thread targeting while ordinary sends require the opt-in", async () => {
  await withParticipantSessionToolsFixture(
    async ({ turn, alice }) => {
      const key = "agent:main:discord:channel:123:thread:456";
      const sessionId = "passive-thread-note";
      await seedSessionToolsFixtureSession({
        sessionKey: key,
        sessionId,
        creatorId: alice.profileId,
        visibility: "draft",
      });
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({
        catalogRef,
        tools: [
          createSessionsSendTool({
            agentSessionKey: REQUESTER,
            requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
          }),
        ],
        hookContext: { runId: "thread-post" },
      });
      const catalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
      const message = "Passive thread consent control";
      await expect(
        catalog.callValue(
          "sessions_send",
          { sessionKey: key, user: alice.profileId, message, timeoutSeconds: 0 },
          { parentToolCallId: "thread-send" },
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: expect.stringContaining("allowThreadTargets"),
      });
      expect(
        JSON.stringify(await loadTranscriptEvents({ agentId: "main", sessionKey: key, sessionId })),
      ).not.toContain(message);
      await expect(
        catalog.callValue(
          "sessions_send",
          { sessionKey: key, user: alice.profileId, message, mode: "post" },
          { parentToolCallId: "thread-post" },
        ),
      ).resolves.toMatchObject({ status: "posted", sessionKey: key });
      expect(
        JSON.stringify(await loadTranscriptEvents({ agentId: "main", sessionKey: key, sessionId })),
      ).toContain(message);
    },
    { visibility: "all" },
  );
});

it.each(["send", "receive"] as const)(
  "revalidates %s consent withdrawn at the durable append boundary",
  async (direction) => {
    await withParticipantSessionToolsFixture(
      async ({ turn, alice }) => {
        const key = PARTICIPANT_DRAFT;
        const marker = "Consent withdrawn before durable append";
        const load = sessionStoreWorker.loadGatewaySessionEntryReadOnlyInWorker;
        const inject = chatInjection.injectGatewayAssistantMessage;
        let boundaryReached = false;
        const readSpy = vi.spyOn(sessionStoreWorker, "loadGatewaySessionEntryReadOnlyInWorker");
        const injectionSpy = vi
          .spyOn(chatInjection, "injectGatewayAssistantMessage")
          .mockImplementationOnce(async (...args) => {
            readSpy.mockImplementationOnce(async (params) => {
              expect(params.key).toBe(key);
              const target = await load(params);
              boundaryReached = true;
              await seedSessionToolsEntry(
                direction === "send" ? REQUESTER : key,
                direction === "send" ? "session-tools-requester-id" : PARTICIPANT_DRAFT_ID,
                { communication: { [direction]: "never" } },
              );
              return target;
            });
            return inject(...args);
          });
        const catalogRef = createToolSearchCatalogRef();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools: [
            createSessionsSendTool({
              agentSessionKey: REQUESTER,
              requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
            }),
          ],
          hookContext: { runId: "withdrawn-post" },
        });
        const catalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
        try {
          await expect(
            catalog.callValue(
              "sessions_send",
              { sessionKey: key, user: alice.profileId, mode: "post", message: marker },
              { parentToolCallId: "withdrawn-post" },
            ),
          ).rejects.toThrow(/communication/i);
        } finally {
          injectionSpy.mockRestore();
          readSpy.mockRestore();
        }
        expect(boundaryReached).toBe(true);
        expect(
          JSON.stringify(
            await loadTranscriptEvents({
              agentId: "main",
              sessionKey: key,
              sessionId: PARTICIPANT_DRAFT_ID,
            }),
          ),
        ).not.toContain(marker);
      },
      { visibility: "all" },
    );
  },
);

it("retains the canonical same-session consent exemption for passive notes", async () => {
  const requester = { sessionKey: "agent:main:dashboard:self-note", sessionId: "self-note-source" };
  await withParticipantSessionToolsFixture(
    async ({ turn, alice }) => {
      await seedSessionToolsEntry(requester.sessionKey, requester.sessionId, {
        communication: { send: "never", receive: "never" },
      });
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({
        catalogRef,
        tools: [
          createSessionsSendTool({
            agentSessionKey: requester.sessionKey,
            requesterTurnRunId: turn.runtimeIdentity.operationalRunInstance.runId,
          }),
        ],
        hookContext: { runId: "self-post" },
      });
      const catalog = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
      await expect(
        catalog.callValue(
          "sessions_send",
          {
            sessionKey: requester.sessionKey,
            user: alice.profileId,
            mode: "post",
            message: "Self-note consent exemption",
          },
          { parentToolCallId: "self-post" },
        ),
      ).resolves.toMatchObject({ status: "posted" });
      expect(
        JSON.stringify(
          await loadTranscriptEvents({
            agentId: "main",
            sessionKey: requester.sessionKey,
            sessionId: requester.sessionId,
          }),
        ),
      ).toContain("Self-note consent exemption");
    },
    { visibility: "all", requester },
  );
});
