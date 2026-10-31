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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { scheduleSkillExperienceReview } from "./experience-review-default.js";
import * as experienceReview from "./experience-review.js";
import { runSkillExperienceReview } from "./experience-review.js";
import { createExperienceReviewCandidate } from "./experience-review.test-support.js";
import { createWorkshopSkill, writeWorkshopSkillFile } from "./library.js";
import type { runSkillWorkshopReview } from "./review-run.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(),
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(async () => {}),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgent,
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
type UsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;
let usageEvents: UsageEvent[];
let stopUsage: () => void;
const prompt = "Remember the verified procedure.";
const makeCandidate = (runId: string, modelId: string) =>
  createExperienceReviewCandidate(runId, [{ role: "user", content: prompt, timestamp: 1 }], {
    workspaceDir: state.workspaceDir,
    modelId,
  });
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  candidate = await makeCandidate("review", "gpt-test");
  setRuntimeConfigSnapshot(candidate.config);
  mocks.runEmbeddedAgent.mockReset();
  mocks.listWorkshopChanges.mockReset().mockResolvedValue([]);
  mocks.postWorkshopChangeNotice.mockClear();
  usageEvents = [];
  stopUsage = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      usageEvents.push(event);
    }
  });
});
afterEach(async () => {
  stopUsage();
  clearPromptCacheObservations();
  vi.restoreAllMocks();
  await state.cleanup();
});

type ReviewParams = Parameters<typeof runSkillWorkshopReview>[0];
const completedReview = { meta: { durationMs: 1 } };
function observe(sessionId: string) {
  beginOpenAIObservation({ sessionId });
  completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });
}
function withAdmission(run: (assertCurrent: ReturnType<typeof activeAssertion>) => Promise<void>) {
  mocks.runEmbeddedAgent.mockImplementation(async (params: ReviewParams) => {
    const admitted = await params.preparedRunAdmission.admit("embedded");
    await run(expectDefined(activeAssertion(admitted, params.abortSignal), "review admission"));
    return completedReview;
  });
}
it.each(["success", "failure"])(
  "cleans up system review diagnostics after %s without affecting the source",
  async (outcome) => {
    const foreground = { sessionId: candidate.source.sessionId };
    observe(foreground.sessionId);
    let reviewSessionId = "";
    mocks.runEmbeddedAgent.mockImplementation(async (params: ReviewParams) => {
      reviewSessionId = params.sessionId;
      expect(params.trigger).toBeUndefined();
      observe(reviewSessionId);
      if (outcome === "failure") {
        throw new Error("review provider failed");
      }
      return completedReview;
    });

    const review = runSkillExperienceReview(candidate);
    await (outcome === "failure"
      ? expect(review).rejects.toThrow("review provider failed")
      : review);

    expect(reviewSessionId).toMatch(/^internal-session-effects-/);
    expect(beginOpenAIObservation({ sessionId: reviewSessionId }).previousCacheRead).toBeNull();
    expect(beginOpenAIObservation(foreground).previousCacheRead).toBe(8_000);
  },
);

it("yields an in-flight review when interactive work starts", async () => {
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
  mocks.runEmbeddedAgent.mockResolvedValue({
    meta: { durationMs: 1, error: { kind: "timeout", message: "model request timed out" } },
  });

  await expect(runSkillExperienceReview(candidate)).rejects.toThrow("model request timed out");
  const { sessionKey, sessionId } = candidate.source;
  expect(mocks.postWorkshopChangeNotice).toHaveBeenCalledWith(
    expect.objectContaining({
      generation: expect.objectContaining({ sessionKey, sessionId }),
      changes: [committed],
    }),
  );
});

it("keeps appended source effects live under receipt pressure without MAIN SQL, then revokes", async () => {
  withAdmission(async (assertCurrent) => {
    const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
    await session.appendMessageWithTranscriptAnchorAsync(
      { role: "user", content: "Continue the foreground task.", timestamp: 2 },
      { config: candidate.config },
    );
    const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    assertCurrent!();
    await withSource(assertCurrent, async () => {
      const scopes = Array.from({ length: 5_000 }, (_, index) => `unrelated-review-${index}`);
      readSqliteDatabaseScopedWriteTokensForPath(candidate.source.storePath, scopes);
      assertCurrent!();
    });
    expect(sql.queries).toEqual([]);
    sql.restore();
    await upsertSessionEntryCore(candidate.source, { permissionMode: "read-only" });
    expect(() => assertCurrent!()).toThrow("no longer active");
  });
  await runSkillExperienceReview(candidate);
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
])(
  "settles review usage without foreground attribution: %j",
  async ({ enabled, hasUsage, failed }) => {
    const usageCandidate = await makeCandidate("usage-review", "usage-fixture");
    usageCandidate.config.diagnostics = { enabled };
    const diagnosticUsage = { input: 100, output: 40, cacheRead: 20, cacheWrite: 10 };
    mocks.runEmbeddedAgent.mockImplementation(async (params: ReviewParams) => ({
      meta: {
        durationMs: 123,
        ...(failed ? { error: { kind: "timeout", message: "synthetic review failed" } } : {}),
        agentMeta: {
          sessionId: params.sessionId,
          ...(hasUsage ? { usage: { input: 10, output: 5 }, diagnosticUsage } : {}),
        },
      },
    }));
    const pending = runSkillExperienceReview(usageCandidate);
    await (failed ? expect(pending).rejects.toThrow("synthetic review failed") : pending);
    expect(usageEvents).toHaveLength(enabled && hasUsage ? 1 : 0);
    if (enabled && hasUsage) {
      const event = expectDefined(usageEvents[0], "Workshop review usage diagnostic");
      expect(event).toMatchObject({
        agentId: "main",
        sessionKey: expect.stringMatching(
          /^agent:main:internal-session-effects:skill-workshop-review/,
        ),
        sessionId: expect.stringMatching(/^internal-session-effects-skill-workshop-review/),
        usage: { ...diagnosticUsage, promptTokens: 130, total: 170 },
      });
      expect(event.channel).toBeUndefined();
      expect(event.costUsd).toBe(0);
    }
  },
);

it("hosts a managed-worktree session's review in its recorded canonical workspace", async () => {
  const canonicalWorkspaceDir = path.join(state.workspaceDir, "canonical");
  const worktreeCandidate = await createExperienceReviewCandidate(
    "worktree-review",
    [{ role: "user", content: prompt, timestamp: 1 }],
    { workspaceDir: state.workspaceDir, modelId: "gpt-test", canonicalWorkspaceDir },
  );
  const prepared = await experienceReview.prepareSkillExperienceReviewCandidate(
    worktreeCandidate,
    worktreeCandidate.config,
  );
  expect(prepared?.ctx.workspaceDir).toBe(canonicalWorkspaceDir);
});

it.each(["off", "tool-policy"] as const)(
  "admits a due review under the current config, so %s refuses it",
  async (restriction) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const prepare = vi.spyOn(experienceReview, "prepareSkillExperienceReviewCandidate");
      expect(
        await experienceReview.prepareSkillExperienceReviewCandidate(candidate, candidate.config),
      ).toEqual({ ...candidate, config: candidate.config });
      prepare.mockClear();
      scheduleSkillExperienceReview({
        event: { messages: [], success: true },
        ctx: {
          ...candidate.ctx,
          sessionKey: candidate.source.sessionKey,
          modelIterations: 10,
          skillWorkshopAvailable: true,
        },
        config: candidate.config,
        source: candidate.source,
      });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      const current =
        restriction === "off"
          ? { ...candidate.config, skills: { workshop: { autonomous: { mode: "off" as const } } } }
          : { ...candidate.config, tools: { ...candidate.config.tools, deny: ["skill_workshop"] } };
      setRuntimeConfigSnapshot(current);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect(prepare.mock.calls[0]?.[1]).toBe(current);
      await expect(prepare.mock.results[0]?.value).resolves.toBeUndefined();
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);
