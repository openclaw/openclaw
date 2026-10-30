import { expect, it, vi } from "vitest";
import {
  acknowledgeInternalToolResult,
  copyInternalToolResultState,
} from "../../../packages/agent-core/src/internal-hooks.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { prepareSessionRowPublication } from "../../gateway/session-row-presentation.js";
import { createTestProjection } from "../../gateway/session-row-projection.read-fixture.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../runtime/index.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { parseSessionEntries, SessionManager } from "../sessions/session-manager.js";
import { loadRequesterSessionEntry } from "../subagents/announce/subagent-announce-delivery.runtime.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../subagents/registry/subagent-registry-publication.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../subagents/registry/subagent-registry-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createAgentsWaitTool,
  readNativeSubagentCollection,
  withNativeSubagentCollectorOwner,
} from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { textResult } from "./tool-results.js";

it.each([
  { name: "retained", healthyChars: 0, maxChars: 16_000 },
  { name: "details-only", healthyChars: 10_000, maxChars: 16_000 },
  { name: "truncated-16k", healthyChars: 100 * 1024, maxChars: 16_000 },
  { name: "truncated-64k", healthyChars: 100 * 1024, maxChars: 64_000 },
  { name: "text-only", healthyChars: 100 * 1024, maxChars: 16_000 },
  ...[
    "message-transform",
    "tool-transform",
    "write-hook",
    "spoof",
    "subset",
    "rejected",
    "unproven",
  ].map((name) => ({ name, healthyChars: 0, maxChars: 16_000 })),
])(
  "certifies only collector failures retained by the real persistence guard: $name",
  async ({ name, healthyChars, maxChars }) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async (state) => {
        const key = "agent:main:collector-persistence";
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const cfg = { session: { store: storePath } };
        setRuntimeConfigSnapshot(cfg);
        const target = { agentId: "main", sessionKey: key, sessionId: "parent", storePath };
        await upsertSessionEntryCore(target, {
          sessionId: "parent",
          lifecycleRevision: "parent-1",
          updatedAt: 1,
        });
        const requester = await loadRequesterSessionEntry(key, "main");
        const failed = {
          ...collectorRun("durable-failure", key),
          childSessionKey: "agent:main:subagent:durable-failure",
          requesterStorePath: requester.physicalStorePath,
          completionRequesterSessionId: "parent",
          completionRequesterLifecycleRevision: "parent-1",
          delivery: { status: "not_required" as const },
          execution: {
            status: "terminal" as const,
            endedAt: 8,
            outcome: { status: "error" as const, error: "synthetic failure" },
          },
          collectorCompletion: { status: "failed" as const },
          completion: {
            required: false,
            resultText: "Saved findings" + (healthyChars > 16_000 ? "F".repeat(10_000) : ""),
          },
        };
        const healthy = {
          ...collectorRun("healthy", key, { status: "done" }),
          delivery: { status: "not_required" as const },
          completionRequesterSessionId: "parent",
          completionRequesterLifecycleRevision: "parent-1",
          execution: {
            status: "terminal" as const,
            endedAt: 7,
            outcome: { status: "ok" as const },
          },
          completion: { required: false, resultText: "H".repeat(healthyChars) },
        };
        const other = {
          ...failed,
          runId: "other-failure",
          childSessionKey: "agent:main:subagent:other-failure",
        };
        const entries = name === "subset" ? [healthy, failed, other] : [healthy, failed];
        persistRegistryFixture(new Map(entries.map((entry) => [entry.runId, entry])));
        await upsertSessionEntryCore(
          { agentId: "main", storePath, sessionKey: failed.childSessionKey },
          {
            sessionId: "child",
            updatedAt: 2,
            spawnedBy: key,
            lastRunId: failed.runId,
            status: "failed",
            lastRunError: "synthetic failure",
          },
        );
        const context = createContext();
        const pending: Promise<unknown>[] = [];
        context.trackExecution = (work) => {
          const task = Promise.resolve().then(work);
          pending.push(task);
          return task;
        };
        const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
        let result = await withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: key, gatewayContextResolver: () => context },
          () =>
            withNativeSubagentCollectorOwner(
              tool,
              "collect",
              {
                currentSessionKeys: new Set([key]),
                currentAgentId: "main",
                expectedRequester: { sessionId: "parent", lifecycleRevision: "parent-1" },
                assertCurrent() {},
              },
              () =>
                tool.execute("collect", {
                  ids: entries.map((entry) => entry.runId).toReversed(),
                  timeoutSeconds: 0,
                }),
            ),
        );
        const collected = readNativeSubagentCollection(result.details);
        expect(collected.completed.map((entry) => entry.runId)).toEqual(
          name === "subset"
            ? [healthy.runId, other.runId, failed.runId]
            : [healthy.runId, failed.runId],
        );
        expect(collected.completed[0]!.result).toBe("H".repeat(healthyChars));
        expect(collected.completed[1]).toMatchObject({
          error: "synthetic failure",
          result: expect.stringContaining("Saved findings"),
        });
        if (name === "text-only") {
          result = copyInternalToolResultState(
            result,
            textResult(JSON.stringify(result.details), { status: "complete" }),
          );
        }
        if (name === "unproven") {
          acknowledgeInternalToolResult(result);
        }
        const handoff = () =>
          loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff;
        expect(handoff()).toBeUndefined();
        expect(pending).toHaveLength(0);
        const manager = await SessionManager.openAsync(target, state.sessionsDir());
        await manager.appendMessageAsync({ role: "user", content: "Review child", timestamp: 1 });
        const entered = createDeferred();
        const release = createDeferred();
        const append = manager.appendMessageWithTranscriptAnchorAsync.bind(manager);
        const appendSpy = vi
          .spyOn(manager, "appendMessageWithTranscriptAnchorAsync")
          .mockImplementation(async (message, options) => {
            if (message.role === "toolResult") {
              entered.resolve();
              await release.promise;
              if (name === "rejected") {
                throw new Error("Rejected collector append");
              }
            }
            return append(message, options);
          });
        const replace = (message: AgentMessage): AgentMessage =>
          message.role !== "toolResult"
            ? message
            : {
                ...message,
                // Keep the raw details untouched: only the committed content proves retention.
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      completed:
                        name === "subset"
                          ? collected.completed.filter((entry) => entry.runId !== failed.runId)
                          : [
                              {
                                ...collected.completed[0],
                                result:
                                  name === "spoof"
                                    ? JSON.stringify(collected.completed[1])
                                    : "replacement",
                              },
                            ],
                      pending: [],
                    }),
                  },
                ],
              };
        installSessionToolResultGuard(manager, {
          maxToolResultChars: maxChars,
          transformMessageForPersistence: name === "message-transform" ? replace : undefined,
          transformToolResultForPersistence: name === "tool-transform" ? replace : undefined,
          beforeMessageWriteHook: ["write-hook", "spoof", "subset"].includes(name)
            ? ({ message }) => ({ message: replace(message) })
            : undefined,
        });
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [
              {
                type: "toolCall",
                id: "collect",
                name: "agents_wait",
                arguments: { ids: [failed.runId, healthy.runId] },
              },
            ],
          }),
        );
        const message = copyInternalToolResultState(result, {
          ...result,
          role: "toolResult",
          toolCallId: "collect",
          toolName: "agents_wait",
          isError: false,
          timestamp: 2,
        } as const);
        const write = manager.appendMessageAsync(message).then(
          (entryId) => ({ entryId }),
          (error: unknown) => ({ error }),
        );
        try {
          await entered.promise;
          expect(handoff()).toBeUndefined();
          expect(pending).toHaveLength(0);
        } finally {
          release.resolve();
          appendSpy.mockRestore();
        }
        const outcome = await write;
        if (name === "rejected") {
          expect(outcome).toMatchObject({ error: new Error("Rejected collector append") });
        } else {
          expect(outcome).toHaveProperty("entryId");
        }
        await Promise.all(pending);
        const messages = await loadTranscriptEvents(target);
        const jsonl = messages.map((event) => JSON.stringify(event)).join("\n");
        const persisted = parseSessionEntries(jsonl)
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
          .find((entry) => entry.role === "toolResult");
        const retained = name === "retained" || name === "details-only";
        if (name === "rejected") {
          expect(persisted).toBeUndefined();
        } else {
          expect(persisted?.role).toBe("toolResult");
          if (persisted?.role !== "toolResult") {
            throw new Error("Missing committed collector result");
          }
          const text = persisted.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          expect(Buffer.byteLength(JSON.stringify(persisted.details))).toBeLessThanOrEqual(8_192);
          if (healthyChars > 8_192 && name !== "text-only") {
            expect(persisted.details).toHaveProperty("persistedDetailsTruncated", true);
          } else {
            expect(persisted.details).not.toHaveProperty("persistedDetailsTruncated");
          }
          if (healthyChars > 16_000) {
            // The real head/tail cap keeps the error, but drops the saved findings and JSON structure.
            expect(text).toContain("synthetic failure");
            expect(text).not.toContain("Saved findings");
            expect(() => JSON.parse(text)).toThrow();
            expect(text.length).toBeLessThanOrEqual(maxChars);
          } else if (retained || name === "unproven") {
            expect(JSON.parse(text)).toEqual(result.details);
          } else {
            expect(
              JSON.parse(text).completed.some(
                (entry: { runId: string }) => entry.runId === failed.runId,
              ),
            ).toBe(false);
            if (name === "spoof") {
              expect(text).toContain("synthetic failure");
            }
          }
        }
        if (persisted?.role === "toolResult") {
          acknowledgeInternalToolResult(message, persisted);
          await Promise.all(pending);
        }
        expect(pending).toHaveLength(retained || name === "subset" ? 1 : 0);
        expect(
          Boolean(loadSubagentRegistryFromSqlite().get(other.runId)?.delivery?.failureHandoff),
        ).toBe(name === "subset");
        // Discard the resident registry view: attention must follow the durable receipt.
        subagentRuns.delete(failed.runId);
        clearSubagentRunsReadCacheForTest();
        publishSubagentRunChanges([failed.childSessionKey, key], [failed.runId]);
        using projection = await createTestProjection({ cfg, modelCatalog: [] });
        await projection.ensureMaterialized();
        const row = prepareSessionRowPublication(projection, Date.now())()
          .getPresentation()
          .snapshot({ agentId: "main", key: failed.childSessionKey }, { rowMode: "sidebar" }).row!;
        expect(row).toMatchObject({ status: "failed", lastRunError: "synthetic failure" });
        expect(row.failureHandedOff === true).toBe(retained);
        expect(Boolean(handoff())).toBe(retained);
        if (retained) {
          expect(handoff()).toMatchObject({
            requesterSessionKey: key,
            requesterSessionId: "parent",
            requesterLifecycleRevision: "parent-1",
          });
        }
      },
    );
  },
);
