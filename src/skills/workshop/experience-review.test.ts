import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAdmittedRunActiveAssertion as activeAssertion } from "../../agents/admitted-run-context.js";
import { runWithAgentToolSourceExecutionScope as withSource } from "../../agents/agent-tool-source-execution-guard.js";
import {
  clearPromptCacheObservations,
  completePromptCacheObservation,
} from "../../agents/embedded-agent-runner/prompt-cache-observability.js";
import { beginOpenAIObservation } from "../../agents/embedded-agent-runner/prompt-cache-observability.test-support.js";
import {
  clearTestEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { readSqliteDatabaseScopedWriteTokensForPath } from "../../infra/sqlite-database-admission.js";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { runSkillExperienceReview } from "./experience-review.js";
import { createExperienceReviewCandidate } from "./experience-review.test-support.js";
import { createWorkshopSkill, writeWorkshopSkillFile } from "./library.js";
import type { runSkillWorkshopReview } from "./review-run.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const mocks = vi.hoisted(() => ({
  runSkillWorkshopReview: vi.fn(),
  runEmbeddedAgent: vi.fn(),
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(async () => {}),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));
vi.mock("./review-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-run.js")>()),
  runSkillWorkshopReview: mocks.runSkillWorkshopReview,
}));
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  listWorkshopChanges: mocks.listWorkshopChanges,
}));
vi.mock("./review-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-outcome.js")>()),
  postWorkshopChangeNotice: mocks.postWorkshopChangeNotice,
}));

let state: OpenClawTestState;
let candidate: Awaited<ReturnType<typeof createExperienceReviewCandidate>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  candidate = await createExperienceReviewCandidate(
    "review",
    [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
    { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
  );
  setRuntimeConfigSnapshot(candidate.config);
  mocks.runSkillWorkshopReview.mockReset();
  mocks.runEmbeddedAgent.mockReset();
  mocks.listWorkshopChanges.mockReset().mockResolvedValue([]);
  mocks.postWorkshopChangeNotice.mockClear();
});
afterEach(async () => {
  clearPromptCacheObservations();
  mocks.runEmbeddedAgent.mockReset();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  await state.cleanup();
});

type ReviewParams = Parameters<typeof runSkillWorkshopReview>[0];
const completedReview = { meta: { durationMs: 1 } };
async function useRealReview() {
  const review = await vi.importActual<{ runSkillWorkshopReview: typeof runSkillWorkshopReview }>(
    "./review-run.js",
  );
  mocks.runSkillWorkshopReview.mockImplementation(review.runSkillWorkshopReview);
}
function withAdmission(run: (assertCurrent: ReturnType<typeof activeAssertion>) => Promise<void>) {
  mocks.runSkillWorkshopReview.mockImplementation(async (params: ReviewParams) => {
    try {
      const admitted = await params.preparedRunAdmission.admit("embedded");
      const assertCurrent = activeAssertion(admitted, params.abortSignal);
      expect(assertCurrent).toBeDefined();
      await run(assertCurrent);
      return completedReview;
    } finally {
      params.preparedRunAdmission.close();
    }
  });
}
it.each(["success", "failure"])(
  "releases a detached review's prompt diagnostics after %s while preserving its source session",
  async (outcome) => {
    await useRealReview();
    const foreground = { sessionId: candidate.source.sessionId };
    beginOpenAIObservation(foreground);
    completePromptCacheObservation({ ...foreground, usage: { cacheRead: 8_000 } });
    let reviewSessionId = "";
    mocks.runEmbeddedAgent.mockImplementation(async (params: ReviewParams) => {
      reviewSessionId = params.sessionId;
      beginOpenAIObservation({ sessionId: reviewSessionId });
      completePromptCacheObservation({
        sessionId: reviewSessionId,
        usage: { cacheRead: 8_000 },
      });
      if (outcome === "failure") {
        throw new Error("review provider failed");
      }
      return completedReview;
    });

    const review = runSkillExperienceReview(candidate);
    if (outcome === "failure") {
      await expect(review).rejects.toThrow("review provider failed");
    } else {
      await review;
    }

    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(beginOpenAIObservation({ sessionId: reviewSessionId }).previousCacheRead).toBeNull();
    expect(beginOpenAIObservation(foreground).previousCacheRead).toBe(8_000);
  },
);

it("yields an in-flight review when interactive work starts", async () => {
  await useRealReview();
  const ownHandle = createEmbeddedRunHandle();
  const interactiveHandle = createEmbeddedRunHandle({ abort: vi.fn() });
  mocks.runEmbeddedAgent.mockImplementation(async (params: ReviewParams) => {
    registerTestEmbeddedRun(params.sessionId, ownHandle, params.sessionKey);
    try {
      expect(params.abortSignal?.aborted).toBe(false);
      registerTestEmbeddedRun("interactive-session", interactiveHandle, "agent:other:interactive");
      expect(params.abortSignal?.aborted).toBe(true);
      expect(interactiveHandle.abort).not.toHaveBeenCalled();
      return { meta: { durationMs: 1, aborted: true } };
    } finally {
      clearTestEmbeddedRun("interactive-session", interactiveHandle);
      clearTestEmbeddedRun(params.sessionId, ownHandle);
    }
  });
  await expect(runSkillExperienceReview(candidate)).rejects.toThrow("yielded to foreground");
  expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
});

it("does not dispatch user reply hooks for a detached experience review", async () => {
  const handler = vi.fn(() => ({ handled: true }));
  const reviewModel = vi.fn(() => completedReview);
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_agent_reply", handler, eligibleTriggers: ["user"] },
    ]),
  );
  await expect(
    runBeforeAgentReplyForTurn({
      runId: "review-user-reply-hook",
      trigger: candidate.ctx.foregroundPromptContext.trigger,
      event: { cleanedBody: "Remember the verified procedure." },
      context: { sessionKey: candidate.source.sessionKey },
    }),
  ).resolves.toEqual({ handled: true });
  expect(handler).toHaveBeenCalledOnce();
  handler.mockClear();

  await useRealReview();
  mocks.runEmbeddedAgent.mockImplementation(async (params: ReviewParams) => {
    const admitted = await params.preparedRunAdmission.admit("embedded");
    const hookResult = await runBeforeAgentReplyForTurn({
      runId: params.runId,
      trigger: params.trigger,
      event: { cleanedBody: params.prompt },
      context: { sessionKey: params.sessionKey, sessionId: params.sessionId },
      assertCurrent: activeAssertion(admitted, params.abortSignal),
    });
    return hookResult?.handled ? completedReview : reviewModel();
  });

  await runSkillExperienceReview(candidate);

  expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
  expect(reviewModel).toHaveBeenCalledOnce();
});

it("announces changes committed before the review run failed", async () => {
  const committed: WorkshopChange = {
    id: "c1",
    agentId: "main",
    skillName: "actual-budget-operations",
    action: "patch",
    actor: "review",
    summary: "tightened reconciliation step",
    createdAtMs: 1,
  };
  mocks.listWorkshopChanges.mockResolvedValue([committed]);
  mocks.runSkillWorkshopReview.mockResolvedValue({
    meta: { durationMs: 1, error: { kind: "timeout", message: "model request timed out" } },
  });

  await expect(runSkillExperienceReview(candidate)).rejects.toThrow("model request timed out");
  expect(mocks.postWorkshopChangeNotice).toHaveBeenCalledWith(
    expect.objectContaining({
      generation: expect.objectContaining({
        sessionKey: candidate.source.sessionKey,
        sessionId: candidate.source.sessionId,
      }),
      changes: [committed],
    }),
  );
});

it("keeps prepared effects live through receipt pressure without MAIN SQL and denies revocation", async () => {
  withAdmission(async (assertCurrent) => {
    const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
    const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    for (let index = 0; index < 5; index += 1) {
      assertCurrent!();
    }
    expect(sql.queries).toEqual([]);
    sql.restore();
    await session.appendMessageWithTranscriptAnchorAsync(
      { role: "user", content: "Continue the foreground task.", timestamp: 2 },
      { config: candidate.config },
    );
    const refreshedSql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    // The model response resumes before the next tool can prepare its source scope.
    assertCurrent!();
    await withSource(assertCurrent, async () => {
      expect(
        readSqliteDatabaseScopedWriteTokensForPath(
          candidate.source.storePath,
          Array.from({ length: 5_000 }, (_, index) => `unrelated-review-${index}`),
        ),
      ).toHaveLength(5_000);
      assertCurrent!();
    });
    expect(refreshedSql.queries).toEqual([]);
    refreshedSql.restore();
    await upsertSessionEntryCore(candidate.source, { permissionMode: "read-only" });
    expect(() => assertCurrent!()).toThrow("no longer active");
  });
  await runSkillExperienceReview(candidate);
  expect(mocks.runSkillWorkshopReview).toHaveBeenCalledOnce();
});

it.each(["permission", "reset", "replacement", "deletion", "rewrite", "membership"] as const)(
  "refuses a Workshop file write after source %s during preparation",
  async (change) => {
    const { source, config } = candidate;
    await upsertSessionEntryCore(source, {
      permissionMode: "guarded",
      lifecycleRevision: "original",
    });
    const context = { config, agentId: "main", actor: "review" as const };
    const original =
      "---\nname: procedure\ndescription: Follow the verified procedure\n---\n\nOriginal steps.\n";
    await createWorkshopSkill(context, { name: "procedure", content: original });
    const skillDir = path.join(resolveWorkshopSkillsDir(config, "main"), "procedure");
    const mutations = {
      permission: () => upsertSessionEntryCore(source, { permissionMode: "read-only" }),
      reset: () => upsertSessionEntryCore(source, { lifecycleRevision: "reset-revision" }),
      replacement: () =>
        upsertSessionEntryCore(source, { sessionId: `${source.sessionId}:replacement` }),
      rewrite: async () => {
        const session = await SessionManager.openAsync(source, state.workspaceDir);
        await session.removeTrailingEntriesAsync((entry) => entry.type === "message");
      },
      membership: () =>
        addSessionMember(source, {
          identityId: "new-member",
          addedBy: "owner",
          expectedSessionId: source.sessionId,
        }),
      deletion: () =>
        deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: source.storePath,
          target: { canonicalKey: source.sessionKey, storeKeys: [source.sessionKey] },
          archiveTranscript: false,
        }),
    };
    let changed = false;
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (args[0] === skillDir && !changed) {
        changed = true;
        await mutations[change]();
      }
      return result;
    });
    withAdmission(async (assertLive) => {
      const write = (content: string) =>
        withSource(assertLive, () =>
          writeWorkshopSkillFile(
            { ...context, assertLive },
            { name: "procedure", filePath: "SKILL.md", content },
          ),
        );
      await expect(write(original.replace("Original", "Changed"))).rejects.toThrow(
        "no longer active",
      );
      await expect(write("must stay denied")).rejects.toThrow();
    });
    await runSkillExperienceReview(candidate);
    expect(changed).toBe(true);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(original);
  },
);

it.each([
  { enabled: true, hasUsage: true, failed: false },
  { enabled: true, hasUsage: true, failed: true },
  { enabled: false, hasUsage: true, failed: false },
  { enabled: true, hasUsage: false, failed: false },
  { enabled: true, hasUsage: true, failed: false, unpriced: true },
])(
  "settles review usage without foreground attribution: %j",
  async ({ enabled, hasUsage, failed, unpriced }) => {
    const usageCandidate = await createExperienceReviewCandidate(
      "usage-review",
      [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "usage-fixture" },
    );
    usageCandidate.config.diagnostics = { enabled };
    const provider = expectDefined(
      usageCandidate.config.models?.providers?.openai,
      "fixture provider",
    );
    provider.models = unpriced
      ? []
      : [
          {
            id: "usage-fixture",
            name: "Usage fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 100_000,
            maxTokens: 2048,
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
          },
        ];
    const events: Extract<DiagnosticEventPayload, { type: "model.usage" }>[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        events.push(event);
      }
    });
    mocks.runSkillWorkshopReview.mockImplementation(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => ({
        meta: {
          durationMs: 123,
          ...(failed ? { error: { kind: "timeout", message: "synthetic review failed" } } : {}),
          agentMeta: {
            sessionId: params.sessionId,
            provider: "openai",
            model: "usage-fixture",
            ...(hasUsage
              ? {
                  usage: { input: 10, output: 5 },
                  diagnosticUsage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 10 },
                }
              : {}),
            lastCallUsage: { input: 10, output: 5 },
            contextTokens: 100_000,
            promptTokens: 10,
          },
        },
      }),
    );
    try {
      const pending = runSkillExperienceReview(usageCandidate);
      if (failed) {
        await expect(pending).rejects.toThrow("synthetic review failed");
      } else {
        await pending;
      }
      expect(events).toHaveLength(enabled && hasUsage ? 1 : 0);
      if (enabled && hasUsage) {
        const event = expectDefined(events[0], "Workshop review usage diagnostic");
        expect(event).toMatchObject({
          agentId: "main",
          sessionKey: expect.stringMatching(
            /^agent:main:internal-session-effects:skill-workshop-review/,
          ),
          sessionId: expect.stringMatching(/^internal-session-effects-skill-workshop-review/),
          provider: "openai",
          model: "usage-fixture",
          usage: {
            input: 100,
            output: 40,
            cacheRead: 20,
            cacheWrite: 10,
            promptTokens: 130,
            total: 170,
          },
          lastCallUsage: { input: 10, output: 5 },
          context: { limit: 100_000, used: 10 },
          durationMs: 123,
        });
        if (unpriced) {
          expect(event.costUsd).toBeUndefined();
        } else {
          expect(event.costUsd).toBeCloseTo(0.0002);
        }
        expect(event.channel).toBeUndefined();
      }
    } finally {
      stop();
    }
  },
);
