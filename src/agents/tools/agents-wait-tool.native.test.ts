import { describe, expect, it, onTestFinished, vi } from "vitest";
import { copyInternalToolResultState } from "../../../packages/agent-core/src/internal-hooks.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { createAgentTurnTestContext } from "../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "../../gateway/agent-turn/agent-run-user-turn.js";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { SessionManager } from "../sessions/session-manager.js";
import * as announceDelivery from "../subagents/announce/subagent-announce-delivery.js";
import { loadRequesterSessionEntry } from "../subagents/announce/subagent-announce-delivery.runtime.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../subagents/announce/subagent-announce.requester-settle-wake.js";
import { mutateRequesterCompletionBatch } from "../subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../subagents/registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../subagents/registry/subagent-registry-publication.js";
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

const key = "agent:main:main";
const owner = {
  currentSessionKeys: new Set([key]),
  currentAgentId: "main",
  expectedRequester: { sessionId: "parent", lifecycleRevision: "revision-2" },
};
const withRegistry = (run: () => Promise<void>) =>
  withOpenClawTestState({ env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } }, run);

async function collectResult({
  signal,
  assertCurrent = () => {},
  ...params
}: Parameters<NativeSubagentRuntime["collect"]>[0] & {
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
  const result = await withNativeSubagentCollectorOwner(
    tool,
    "native-collector-test",
    { ...owner, assertCurrent },
    () => tool.execute("native-collector-test", params, signal),
  );
  return result;
}

async function collect(params: Parameters<typeof collectResult>[0]) {
  return readNativeSubagentCollection((await collectResult(params)).details);
}

function committedHandoff(ids: string[]) {
  const committed = createDeferred();
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
    if (ids.every((id) => subagentRuns.get(id)?.delivery?.failureHandoff)) {
      committed.resolve();
    }
  });
  onTestFinished(unsubscribe);
  return committed.promise;
}

function record(
  id: string,
): import("../subagents/registry/subagent-registry.types.js").SubagentRunRecord {
  return {
    ...collectorRun(id, key),
    delivery: { status: "not_required" as const },
    completionRequesterSessionId: "parent",
    completionRequesterLifecycleRevision: "revision-2",
  };
}

describe("native collector requester ownership", () => {
  it("reads persisted pending and completed results, refusing other parents and reset incarnations", async () => {
    await withRegistry(async () => {
      const done = {
        ...record("done"),
        collectorCompletion: { status: "done" as const },
        completion: { required: false, resultText: "reviewed" },
      };
      const reset = { ...record("reset"), completionRequesterLifecycleRevision: "revision-1" };
      const foreign = { ...record("foreign"), swarmRequesterSessionKey: "agent:main:other" };
      persistRegistryFixture(
        new Map([done, record("pending"), reset, foreign].map((entry) => [entry.runId, entry])),
      );
      const result = await collect({
        ids: ["done", "pending", "reset", "foreign", "missing"],
        timeoutSeconds: 0,
      });
      expect(result.completed).toMatchObject([
        { runId: "done", result: "reviewed", status: "done" },
      ]);
      expect(result.pending).toEqual(["pending"]);
      expect(result.errors).toEqual([
        { runId: "reset", error: "not_owner" },
        { runId: "foreign", error: "not_owner" },
        { runId: "missing", error: "not_found" },
      ]);
    });
  });

  it.each(["error", "timeout"] as const)(
    "returns a persisted %s cause and retained progress",
    async (status) => {
      await withRegistry(async () => {
        const failed = {
          ...record("failed"),
          execution: {
            status: "terminal" as const,
            endedAt: 8,
            outcome: { status, error: "synthetic provider unavailable" },
          },
          collectorCompletion: {
            status: status === "timeout" ? ("timeout" as const) : ("failed" as const),
          },
          completion: { required: false, resultText: "Saved investigation progress" },
        };
        persistRegistryFixture(new Map([[failed.runId, failed]]));
        const result = await collect({ ids: [failed.runId], timeoutSeconds: 0 });
        expect(result.completed).toMatchObject([
          {
            runId: "failed",
            status: status === "timeout" ? "timeout" : "failed",
            error: "synthetic provider unavailable",
            result: "Saved investigation progress\n\nSaved partial progress unavailable.",
          },
        ]);
        expect(result.completed[0]?.resultTruncated).toBeUndefined();
        expect(result.pending).toEqual([]);
        expect(result.errors).toBeUndefined();
      });
    },
  );

  it.each(["error", "timeout"] as const)(
    "bounds the complete %s result including genuine multibyte partial progress",
    async (status) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          setRuntimeConfigSnapshot({ agents: { entries: { main: {}, worker: {} } } });
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "worker" });
          const failed = record("large-progress");
          const target = {
            agentId: "worker",
            sessionKey: failed.childSessionKey,
            sessionId: "large-child",
            storePath,
          };
          await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
          const manager = await SessionManager.openAsync(target, state.sessionsDir("worker"));
          await manager.appendMessageAsync({ role: "user", content: "Investigate", timestamp: 1 });
          await manager.appendMessageAsync(
            attachSessionTranscriptRunId(
              makeAgentAssistantMessage({
                content: [
                  {
                    type: "text",
                    text: "Measured progress: " + "界".repeat(40_000) + "END-OF-PROGRESS",
                  },
                ],
              }),
              failed.runId,
            ),
          );
          failed.execution = {
            status: "terminal",
            endedAt: 8,
            outcome: { status, error: "Required failure cause" },
            transcriptTarget: target,
          };
          failed.collectorCompletion = { status: status === "timeout" ? "timeout" : "failed" };
          failed.completion = { required: false, resultText: "Required failure cause" };
          persistRegistryFixture(new Map([[failed.runId, failed]]));
          const result = (await collect({ ids: [failed.runId], timeoutSeconds: 0 })).completed[0]!;
          expect(result).toMatchObject({
            status: status === "timeout" ? "timeout" : "failed",
            error: "Required failure cause",
            resultTruncated: true,
          });
          expect(result.result).toContain("Required failure cause");
          expect(result.result).toContain(
            "Saved partial progress (not a completed result):\nMeasured progress: 界",
          );
          expect(Buffer.byteLength(result.result, "utf8")).toBeLessThanOrEqual(100 * 1024);
          expect(result.result).toContain("[truncated: frozen completion output exceeded 100KB");
          expect(result.result).not.toContain("END-OF-PROGRESS");
          expect(result.result).not.toContain("�");
        },
      );
    },
  );

  it.each([1, 2])(
    "assigns %s-source ancestor collection to its actual durable consumer, not the failed spawners",
    async (count) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          setRuntimeConfigSnapshot({ session: { store: storePath } });
          const target = { agentId: "main", sessionKey: key, sessionId: "ancestor", storePath };
          await upsertSessionEntryCore(target, {
            sessionId: "ancestor",
            lifecycleRevision: "ancestor-1",
            updatedAt: 1,
          });
          const entries = await Promise.all(
            ["failed-g", "failed-other-g"].slice(0, count).map(async (prefix) => {
              const id = prefix + "-" + count;
              const spawner = "agent:main:subagent:" + id;
              await upsertSessionEntryCore(
                { ...target, sessionKey: spawner },
                { sessionId: id, lifecycleRevision: "spawner-1", status: "failed", updatedAt: 1 },
              );
              const source = await loadRequesterSessionEntry(spawner, "main");
              return Object.assign(collectorRun(id + "-child", spawner), {
                requesterStorePath: source.physicalStorePath,
                completionRequesterSessionId: id,
                completionRequesterLifecycleRevision: "spawner-1",
                swarmWaitOwnerSessionKeys: [spawner, key],
                delivery: { status: "not_required" as const },
                execution: {
                  status: "terminal" as const,
                  endedAt: 8,
                  outcome: { status: "error" as const, error: id + " failed" },
                },
                collectorCompletion: { status: "failed" as const },
                completion: { required: false, resultText: id + " saved work" },
              });
            }),
          );
          persistRegistryFixture(new Map(entries.map((entry) => [entry.runId, entry])));
          const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
          const result = await withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: key },
            () =>
              withNativeSubagentCollectorOwner(
                tool,
                "ancestor-collect",
                { currentSessionKeys: new Set([key]), currentAgentId: "main", assertCurrent() {} },
                () =>
                  tool.execute("ancestor-collect", {
                    ids: entries.map((entry) => entry.runId),
                    timeoutSeconds: 0,
                  }),
              ),
          );
          expect(readNativeSubagentCollection(result.details).completed).toHaveLength(count);
          expect(
            entries.every(
              (entry) =>
                !loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery?.failureHandoff,
            ),
          ).toBe(true);
          const manager = await SessionManager.openAsync(target, state.sessionsDir());
          await manager.appendMessageAsync({
            role: "user",
            content: "Recover descendant work",
            timestamp: 1,
          });
          installSessionToolResultGuard(manager);
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "toolCall",
                  id: "ancestor-collect",
                  name: "agents_wait",
                  arguments: { ids: entries.map((entry) => entry.runId) },
                },
              ],
            }),
          );
          const committed = committedHandoff(entries.map((entry) => entry.runId));
          await manager.appendMessageAsync(
            copyInternalToolResultState(
              result,
              makeTextToolResult(
                "ancestor-collect",
                "agents_wait",
                JSON.stringify(result.details),
                false,
                2,
              ),
            ),
          );
          await committed;
          {
            for (const entry of entries) {
              const saved = loadSubagentRegistryFromSqlite().get(entry.runId)!;
              expect(saved.delivery?.failureHandoff).toMatchObject({
                requesterSessionKey: key,
                requesterSessionId: "ancestor",
                requesterLifecycleRevision: "ancestor-1",
              });
              expect(saved.requesterSessionKey).toBe(entry.requesterSessionKey);
              expect(saved.completionRequesterSessionId).toBe(entry.completionRequesterSessionId);
              expect(saved.swarmWaitOwnerSessionKeys).toEqual(entry.swarmWaitOwnerSessionKeys);
              expect(saved.delivery?.status).toBe("not_required");
            }
          }
          expect(JSON.stringify(await loadTranscriptEvents(target))).toContain(
            "failed-g-" + count + " failed",
          );
        },
      );
    },
  );

  it.each(["reset", "revoke", "policy", "abort", "source", "ownership", "foreign"] as const)(
    "does not certify ancestor custody after %s",
    async (change) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          setRuntimeConfigSnapshot({ session: { store: storePath } });
          const target = { agentId: "main", sessionKey: key, sessionId: "ancestor", storePath };
          await upsertSessionEntryCore(target, {
            sessionId: "ancestor",
            lifecycleRevision: "ancestor-1",
            updatedAt: 1,
          });
          const failed = {
            ...collectorRun("revoked-child-" + change, "agent:main:subagent:failed-spawner"),
            delivery: { status: "not_required" as const },
            swarmWaitOwnerSessionKeys: [
              "agent:main:subagent:failed-spawner",
              ...(change === "foreign" ? [] : [key]),
            ],
            execution: {
              status: "terminal" as const,
              endedAt: 8,
              outcome: { status: "error" as const, error: "Revocation cause" },
            },
            collectorCompletion: { status: "failed" as const },
            completion: { required: false, resultText: "Saved work" },
          };
          persistRegistryFixture(new Map([[failed.runId, failed]]));
          let active = true;
          let allowed = true;
          const controller = new AbortController();
          const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
          const result = await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: key,
              assertToolAllowed: () => {
                if (!allowed) {
                  throw new Error("policy revoked");
                }
              },
            },
            () =>
              withNativeSubagentCollectorOwner(
                tool,
                "collect-negative",
                {
                  currentSessionKeys: new Set([key]),
                  currentAgentId: "main",
                  assertCurrent() {
                    if (!active) {
                      throw new Error("consumer revoked");
                    }
                  },
                },
                () =>
                  tool.execute(
                    "collect-negative",
                    { ids: [failed.runId], timeoutSeconds: 0 },
                    controller.signal,
                  ),
              ),
          );
          const collected = readNativeSubagentCollection(result.details);
          if (change === "foreign") {
            expect(collected.completed).toEqual([]);
            expect(collected.errors).toEqual([{ runId: failed.runId, error: "not_owner" }]);
          } else {
            expect(collected.completed).toHaveLength(1);
          }
          if (change === "reset") {
            await upsertSessionEntryCore(target, {
              sessionId: "ancestor",
              lifecycleRevision: "ancestor-2",
              updatedAt: 2,
            });
          }
          if (change === "revoke") {
            active = false;
          }
          if (change === "policy") {
            allowed = false;
          }
          if (change === "abort") {
            controller.abort();
          }
          if (change === "source" || change === "ownership") {
            await mutateSubagentRuns(
              [failed.runId],
              (rows) => {
                const source = rows.get(failed.runId)!;
                const replacement =
                  change === "source"
                    ? { ...source, generation: 2 }
                    : { ...source, swarmWaitOwnerSessionKeys: [source.requesterSessionKey] };
                return { value: undefined, postimages: new Map([[failed.runId, replacement]]) };
              },
              { preparedRows: () => new Map([[failed.runId, failed]]) },
            );
          }
          const manager = await SessionManager.openAsync(target, state.sessionsDir());
          await manager.appendMessageAsync({
            role: "user",
            content: "Inspect saved failure",
            timestamp: 1,
          });
          installSessionToolResultGuard(manager);
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "toolCall",
                  id: "collect-negative",
                  name: "agents_wait",
                  arguments: { ids: [failed.runId] },
                },
              ],
            }),
          );
          const warning = vi
            .spyOn((await import("../../runtime.js")).defaultRuntime, "log")
            .mockImplementation(() => {});
          try {
            await manager.appendMessageAsync(
              copyInternalToolResultState(
                result,
                makeTextToolResult(
                  "collect-negative",
                  "agents_wait",
                  JSON.stringify(result.details),
                  false,
                  2,
                ),
              ),
            );
            if (change !== "foreign") {
              await vi.waitFor(() => {
                expect(
                  loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
                ).toBeUndefined();
                expect(warning).toHaveBeenCalledWith(
                  expect.stringContaining("Collector failure handoff could not be recorded"),
                );
              });
            }
            expect(
              loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
            ).toBeUndefined();
          } finally {
            warning.mockRestore();
          }
        },
      );
    },
  );

  it.each([
    [false, false, undefined],
    [true, false, undefined],
    [true, true, undefined],
    [true, false, "changed"],
    [true, false, "unchanged"],
    [true, false, "legacy"],
    [true, false, "replacement"],
  ] as const)(
    "leaves omitted settle failures unacknowledged (visible failure=%s, rejected=%s, private retry=%s)",
    async (visibleFailure, rejected, retry) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async () => {
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          setRuntimeConfigSnapshot({ session: { store: storePath } });
          const target = { agentId: "main", sessionKey: key, sessionId: "parent", storePath };
          const entry = { sessionId: "parent", lifecycleRevision: "revision-2", updatedAt: 1 };
          await upsertSessionEntryCore(target, entry);
          const requester = await loadRequesterSessionEntry(key, "main");
          const failed = (id: string, createdAt: number) => ({
            ...record(id),
            createdAt,
            requesterStorePath: requester.physicalStorePath,
            execution: {
              status: "terminal" as const,
              endedAt: 8,
              outcome: { status: "error" as const, error: id + " cause" },
            },
            collectorCompletion: { status: "failed" as const },
            completion: { required: false, resultText: id + " saved progress" },
          });
          const tail = failed("omitted-tail", 1_000);
          const visible = failed("visible-failure", 0);
          const failures = visibleFailure ? [visible, tail] : [tail];
          // Only the failed sources need native rows. This bounded pure inventory
          // fills the production prefix without opening hundreds of child runtimes.
          const healthy = Array.from({ length: 600 }, (_, index) => ({
            ...record("healthy-" + index),
            childSessionKey: "agent:main:subagent:healthy-" + index,
            task: "Healthy " + index,
            createdAt: index + 1,
            execution: {
              status: "terminal" as const,
              endedAt: 8,
              outcome: { status: "ok" as const },
            },
            completion: { required: false, resultText: "HEALTHY_SETTLE_FINDING".repeat(30) },
          }));
          const children = [...healthy, ...failures];
          const batchRunIds = children.map((child) => child.runId);
          for (const child of children) {
            subagentRuns.set(child.runId, {
              ...child,
              requesterAgentId: "main",
              requesterStorePath: requester.physicalStorePath,
              collect: false,
              completionTarget: retry ? "parent" : undefined,
              collectorCompletion: undefined,
              expectsCompletionMessage: true,
              requesterSettleWake: { status: "pending", attemptCount: 0, batchRunIds },
            });
          }
          persistRegistryFixture(
            new Map(
              (retry ? children : failures).map((child) => [
                child.runId,
                subagentRuns.get(child.runId)!,
              ]),
            ),
          );
          // Transport/model execution is isolated. Private retries persist their real
          // batch transitions, then reconstruct the retained input from SQLite.
          let firstMessage: string | undefined;
          let firstRunId: string | undefined;
          const completed =
            vi.fn<
              Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]["completeBatch"]
            >();
          const deliver = vi.spyOn(announceDelivery, "deliverSubagentAnnouncement");
          onTestFinished(() => deliver.mockRestore());
          deliver.mockImplementation(async (dispatch) => {
            const message = dispatch.triggerMessage;
            const firstAttempt = retry !== undefined && firstMessage === undefined;
            const refuseInput = rejected || firstAttempt;
            if (retry) {
              if (firstAttempt) {
                firstMessage = message;
                firstRunId = dispatch.directIdempotencyKey;
              } else {
                expect(message).toBe(firstMessage);
                expect(dispatch.directIdempotencyKey).toBe(firstRunId);
              }
              await dispatch.onBeforeDispatch?.();
              dispatch.onAccepted?.({ runId: dispatch.directIdempotencyKey });
            }
            const findings = message.slice(message.indexOf("Child completion results:"));
            expect(findings.length).toBeLessThanOrEqual(160_000);
            expect(findings.isWellFormed()).toBe(true);
            expect(message).not.toContain("omitted-tail saved progress");
            expect(message).toContain("additional child results omitted");
            expect(message).toContain("Inspect remaining children");
            expect(dispatch.onInputCommitted).toBeTypeOf("function");
            const onInputCommitted = vi.fn(dispatch.onInputCommitted!);
            expect(dispatch.isSourceSessionEffectsAllowed?.()).toBe(true);
            const turn = await prepareAgentRunUserTurn({
              cfg: { session: { store: storePath } },
              resolvedSessionKey: key,
              admittedSessionId: "parent",
              activeSessionAgentId: "main",
              sessionEntry: entry,
              privateCompletion: retry ? true : undefined,
              settleWakeReplay: retry
                ? {
                    sourceSessionKeys: dispatch.settleWakeSourceSessionKeys!,
                    assertCurrent: () => {
                      expect(dispatch.isSourceSessionEffectsAllowed?.()).toBe(true);
                    },
                  }
                : undefined,
              assertCurrent: () => {},
              onUserTurnMediaPersisted: () => {},
              suppressVisibleSessionEffects: false,
              requestedPromptPersistenceSuppression: false,
              canUseInternalRuntimeHandoff: false,
              message,
              effectiveTranscriptInputText: message,
              images: [],
              offloadedRefs: [],
              runId: dispatch.directIdempotencyKey,
              client: null,
              context: createAgentTurnTestContext(),
              onInputCommitted,
              inputProvenance: {
                kind: "inter_session",
                sourceTool: "subagent_settle",
                sourceSessionKey: dispatch.sourceSessionKey,
              },
              request: {
                message,
                idempotencyKey: dispatch.directIdempotencyKey,
                deliver: false,
                expectedExistingSessionId: "parent",
              },
            });
            try {
              expect(turn.recorder).toBeDefined();
              const write = turn.recorder!.persistApproved(
                refuseInput
                  ? {
                      target: async () => {
                        throw new Error("Input refused");
                      },
                    }
                  : undefined,
              );
              if (refuseInput) {
                await expect(write).rejects.toThrow("Input refused");
                expect(onInputCommitted).not.toHaveBeenCalled();
                expect(await loadTranscriptEvents(target)).toEqual([]);
              } else {
                expect(await write).toMatchObject({ appended: true });
                expect(onInputCommitted).toHaveBeenCalledOnce();
                await onInputCommitted.mock.results[0]?.value;
              }
              if (refuseInput) {
                const saved = loadSubagentRegistryFromSqlite();
                expect(saved.get(tail.runId)?.delivery?.failureHandoff).toBeUndefined();
                expect(saved.get(visible.runId)?.delivery?.failureHandoff).toBeUndefined();
              }
              const transcript = JSON.stringify(await loadTranscriptEvents(target));
              if (!refuseInput) {
                expect(await loadTranscriptEvents(target)).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      message: expect.objectContaining({
                        role: "user",
                        display: false,
                        content: message,
                      }),
                    }),
                  ]),
                );
                expect(transcript).toContain("HEALTHY_SETTLE_FINDING");
              }
              expect(transcript).not.toContain("omitted-tail saved progress");
              if (visibleFailure && !refuseInput) {
                expect(transcript).toContain("visible-failure cause");
                expect(transcript).toContain("visible-failure saved progress");
              }
            } finally {
              await releasePreparedAgentRunUserTurn(turn);
            }
            return firstAttempt
              ? {
                  delivered: false,
                  path: "direct",
                  disposition: "retryable",
                  reason: "requester_transcript_conflict",
                }
              : { delivered: !rejected, path: "direct" };
          });
          const wake = () =>
            maybeWakeRequesterAfterAllChildrenSettled({
              requesterSessionKey: key,
              settledEntry: subagentRuns.get(tail.runId)!,
              isSourceCurrent: () => true,
              transitionBatch: async (entries, next, onPublished) => {
                if (!retry) {
                  return;
                }
                expect(
                  await mutateRequesterCompletionBatch({
                    entries,
                    operation: { kind: "transition", state: next },
                    assertCurrent: () => {},
                    onPublished: () =>
                      onPublished?.(entries.map((member) => subagentRuns.get(member.runId)!)),
                  }),
                ).toEqual({ applied: true, publication: "published" });
              },
              completeBatch: completed,
            });
          if (retry) {
            expect(await wake()).toBe(false);
            expect(deliver).toHaveBeenCalledOnce();
            const saved = loadSubagentRegistryFromSqlite();
            const retained = saved.get(tail.runId)!.requesterSettleWake!;
            expect(retained).toMatchObject({
              status: "pending",
              attemptCount: 1,
              privateInput: { runId: firstRunId, message: firstMessage },
            });
            expect(retained.nextAttemptAt).toBeGreaterThan(Date.now());
            for (const child of saved.values()) {
              child.requesterSettleWake!.nextAttemptAt = 0;
              if (retry === "legacy") {
                child.requesterSettleWake!.privateInput = {
                  runId: firstRunId!,
                  message: firstMessage!,
                };
              }
              if (
                (retry === "changed" || retry === "legacy") &&
                child.runId.startsWith("healthy-")
              ) {
                // The frozen wave still owns this row; its old result is obsolete.
                child.killReconciliation = { killedAt: 8, supersededAt: 9 };
              }
              if (retry === "replacement" && child.runId === visible.runId) {
                child.generation = 2;
              }
            }
            persistRegistryFixture(saved);
            subagentRuns.clear();
            clearSubagentRunsReadCacheForTest();
            for (const [id, child] of loadSubagentRegistryFromSqlite()) {
              subagentRuns.set(id, child);
            }
          }
          const delivered = await wake();
          expect(deliver).toHaveBeenCalledTimes(retry ? 2 : 1);
          expect(completed.mock.calls.at(-1)?.[2]?.error).toBeUndefined();
          expect(delivered).toBe(!rejected);
          const saved = loadSubagentRegistryFromSqlite();
          expect(saved.get(tail.runId)?.delivery?.failureHandoff).toBeUndefined();
          expect(Boolean(saved.get(visible.runId)?.delivery?.failureHandoff)).toBe(
            visibleFailure && !rejected && retry !== "legacy" && retry !== "replacement",
          );
        },
      );
    },
  );

  it.each(["abort", "revoke"] as const)(
    "refuses %s during asynchronous result preparation",
    async (failure) => {
      await withRegistry(async () => {
        persistRegistryFixture(new Map([["pending", record("pending")]]));
        const controller = new AbortController();
        const entered = createDeferred();
        let active = true;
        const result = collect({
          ids: ["pending"],
          awaitResults: true,
          signal: controller.signal,
          assertCurrent() {
            entered.resolve();
            if (!active) {
              throw new Error("request retired");
            }
          },
        });
        await entered.promise;
        if (failure === "revoke") {
          active = false;
        } else {
          controller.abort();
        }
        await expect(result).rejects.toThrow(failure === "revoke" ? "request retired" : "aborted");
      });
    },
  );
});
