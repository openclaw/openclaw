import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  appendTranscriptMessage,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sharingPreparation from "../session-sharing-preparation.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";
import type { RespondFn } from "./types.js";

describe("chat history registry projection", () => {
  it("keeps an empty history available across unrelated catalog publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await createHistoryReadContext();
      const prepare = sharingPreparation.prepareSessionMutationFacts;
      const probe = vi
        .spyOn(sharingPreparation, "prepareSessionMutationFacts")
        .mockImplementation(async (params) => {
          try {
            return await prepare(params);
          } finally {
            sessionChanges.emit({ all: true, scope: "catalog" });
          }
        });
      try {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey: "agent:main:empty" },
          respond,
          req: { type: "req", id: "empty-history", method: "chat.history" },
          client: null,
          isWebchatConnect: () => false,
          context,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({ messages: [], sessionId: undefined }),
        );
      } finally {
        probe.mockRestore();
      }
    });
  });

  it.each(["global", "per-sender"] as const)(
    "reads the selected agent's %s main alias before a competing literal row",
    async (sessionScope) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          session: { scope: sessionScope, mainKey: "home" },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        for (const agentId of ["main", "work"]) {
          const scope = {
            agentId,
            sessionKey: sessionScope === "global" ? "global" : `agent:${agentId}:home`,
            sessionId: `selected-history-${agentId}`,
          };
          await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          await appendTranscriptMessage(scope, {
            message: { role: "user", content: `Selected ${agentId} history` },
            now: 1,
          });
          const literalScope = {
            agentId,
            sessionKey: `agent:${agentId}:main`,
            sessionId: `literal-history-${agentId}`,
          };
          replaceSessionEntrySync(literalScope, {
            sessionId: literalScope.sessionId,
            updatedAt: 1,
          });
          await appendTranscriptMessage(literalScope, {
            message: { role: "user", content: `Literal ${agentId} history` },
            now: 1,
          });
        }
        const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey: "agent:work:main" },
          respond,
          req: { type: "req", id: "selected-global-history", method: "chat.history" },
          client: null,
          isWebchatConnect: () => false,
          context,
        });

        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            sessionId: "selected-history-work",
            messages: [expect.objectContaining({ content: "Selected work history" })],
            sessionInfo: expect.objectContaining({
              key: sessionScope === "global" ? "global" : "agent:work:home",
              agentId: "work",
            }),
          }),
        );
      });
    },
  );

  it.each(["chat.history", "chat.startup"] as const)(
    "%s polls an unchanged cursor without hydrating retained subagent tasks",
    async (method) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async () => {
          const scope = {
            agentId: "main",
            sessionKey: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001",
            sessionId: "registry-history",
          };
          await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          await appendTranscriptMessage(scope, {
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          });
          saveSubagentRegistryToSqlite(
            new Map([
              [
                "retained",
                {
                  runId: "retained",
                  childSessionKey: "agent:main:subagent:retained",
                  requesterSessionKey: scope.sessionKey,
                  requesterDisplayKey: "registry-history",
                  task: `retained-history-task:${"x".repeat(32_768)}`,
                  cleanup: "keep",
                  createdAt: 1,
                  execution: { status: "terminal", startedAt: 1, endedAt: 2 },
                  completion: { required: false },
                  delivery: { status: "not_required" },
                },
              ],
            ]),
          );
          const context = await createHistoryReadContext();
          const request = async (cursor?: unknown) => {
            let result: unknown;
            await expectDefined(
              chatHistoryHandlers[method],
              "history handler",
            )({
              params:
                method === "chat.startup" && !cursor
                  ? { shortId: "12345678", slugHint: "registry-history", agentId: "main" }
                  : { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) },
              context,
              req: { type: "req", id: "registry-history", method },
              client: null,
              isWebchatConnect: () => false,
              respond: (ok, payload, error) => {
                expect(error).toBeUndefined();
                expect(ok).toBe(true);
                result = payload;
              },
            });
            return expectDefined(asOptionalRecord(result), "history response");
          };
          const initial = await request();
          expect(initial.deltaCursor).toEqual(expect.any(String));
          if (method === "chat.startup") {
            expect(initial.resolution).toMatchObject({ ok: true, key: scope.sessionKey });
          }
          clearSubagentRunsReadCacheForTest();
          const parse = vi.spyOn(JSON, "parse");
          try {
            const delta = await request(initial.deltaCursor);
            expect(delta).toMatchObject({ kind: "delta", messages: [] });
            expect(
              parse.mock.calls.some(([value]) => value.includes("retained-history-task:")),
            ).toBe(false);
          } finally {
            parse.mockRestore();
            clearSubagentRunsReadCacheForTest();
          }
        },
      );
    },
  );
});

it.each(["workspace", "library", "label"] as const)(
  "rechecks startup skill scope after a same-session %s update during discovery",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:startup-scope",
        sessionId: "startup-scope",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "same-lifecycle",
        updatedAt: 1,
        spawnedCwd: "/projects/first",
      });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "History remains in this session" },
      });
      const harness = createChatMetadataHarness();
      const entered = createDeferred();
      const release = createDeferred();
      let startup: Promise<void> | undefined;
      try {
        await harness.runtime.refresh();
        await harness.runtime.read({ agentId: "main" });
        harness.buildCommands.mockImplementationOnce(async ({ sessionEntry }) => {
          expect(sessionEntry?.spawnedCwd).toBe("/projects/first");
          entered.resolve();
          await release.promise;
          return { commands: [{ name: "old-project-skill" }] };
        });
        const context = await createHistoryReadContext({
          readChatStartupProjection: harness.runtime.readStartup,
        });
        const respond = vi.fn<RespondFn>();
        startup = Promise.resolve(
          expectDefined(
            chatHistoryHandlers["chat.startup"],
            "startup handler",
          )({
            params: { sessionKey: scope.sessionKey },
            respond,
            req: { type: "req", id: "startup-rebind", method: "chat.startup" },
            client: null,
            isWebchatConnect: () => false,
            context,
          }),
        );
        await entered.promise;
        const updated = await upsertSessionEntryCore(
          scope,
          change === "workspace"
            ? { spawnedCwd: "/projects/second" }
            : change === "library"
              ? {
                  skillLibrarySelections: [
                    {
                      skillId: "00000000-0000-4000-8000-000000000001",
                      revision: "a".repeat(64),
                      name: "new-library-skill",
                      ownerProfileId: null,
                    },
                  ],
                }
              : { label: "New display label" },
        );
        expect(updated).toMatchObject({
          sessionId: scope.sessionId,
          lifecycleRevision: "same-lifecycle",
        });
        release.resolve();
        await startup;
        expect(respond).toHaveBeenCalledOnce();
        if (change === "label") {
          expect(respond.mock.calls[0]).toMatchObject([
            true,
            {
              metadata: { commands: [{ name: "old-project-skill" }] },
              sessionInfo: { label: "New display label" },
            },
          ]);
        } else {
          expect(respond.mock.calls[0]).toMatchObject([
            false,
            undefined,
            { code: "UNAVAILABLE", retryable: true },
          ]);
        }
      } finally {
        release.resolve();
        await startup;
        await harness.runtime.stop();
      }
    });
  },
);
