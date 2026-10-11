import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticModelUsageEvent,
} from "../../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
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
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(async () => {}),
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
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  mocks.runSkillWorkshopReview.mockReset();
  mocks.listWorkshopChanges.mockReset().mockResolvedValue([]);
  mocks.postWorkshopChangeNotice.mockClear();
});
afterEach(async () => {
  await state.cleanup();
});

describe("runSkillExperienceReview", () => {
  it.each([
    { enabled: true, hasUsage: true, failed: false },
    { enabled: true, hasUsage: true, failed: true },
    { enabled: false, hasUsage: true, failed: false },
    { enabled: true, hasUsage: false, failed: false },
    { enabled: true, hasUsage: true, failed: false, unpriced: true },
  ])(
    "settles review usage without foreground attribution: %j",
    async ({ enabled, hasUsage, failed, unpriced }) => {
      const candidate = await createExperienceReviewCandidate(
        "usage-review",
        [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
        { workspaceDir: state.workspaceDir, modelId: "usage-fixture" },
      );
      candidate.config.diagnostics = { enabled };
      candidate.config.models!.providers!.openai.models = unpriced
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
      const events: DiagnosticModelUsageEvent[] = [];
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
        const pending = runSkillExperienceReview(candidate);
        if (failed) {
          await expect(pending).rejects.toThrow("synthetic review failed");
        } else {
          await pending;
        }
        expect(events).toHaveLength(enabled && hasUsage ? 1 : 0);
        if (enabled && hasUsage) {
          expect(events[0]).toMatchObject({
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
            expect(events[0].costUsd).toBeUndefined();
          } else {
            expect(events[0].costUsd).toBeCloseTo(0.0002);
          }
          expect(events[0].channel).toBeUndefined();
        }
      } finally {
        stop();
      }
    },
  );

  it("announces changes committed before the review run failed", async () => {
    const workspaceDir = state.workspaceDir;
    const candidate = await createExperienceReviewCandidate(
      "review-fails-after-commit",
      [{ role: "user", content: "Reconcile the budget.", timestamp: 1 }],
      { workspaceDir, modelId: "gpt-test" },
    );
    const committed: WorkshopChange = {
      id: "c1",
      agentId: "main",
      skillName: "actual-budget-operations",
      action: "patch",
      actor: "review",
      summary: "tightened reconciliation step",
      versionId: "20260101T000000001Z-patch",
      createdAtMs: 1,
    };
    mocks.listWorkshopChanges.mockResolvedValue([committed]);
    // The skill_workshop call committed; the follow-up model request then timed out.
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

  it("checks source authority and its accepted anchor together after a later append", async () => {
    const candidate = await createExperienceReviewCandidate(
      "review-append",
      [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    mocks.runSkillWorkshopReview.mockImplementation(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
        try {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const assertCurrent = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
          expect(assertCurrent).toBeDefined();
          assertCurrent!();
          const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
          await session.appendMessageWithTranscriptAnchorAsync(
            { role: "user", content: "Continue the foreground task.", timestamp: 2 },
            { config: candidate.config },
          );
          const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
          try {
            assertCurrent!();
            expect(
              sql.queries.filter((query) =>
                /\b(?:session_nodes|transcript_event_identities)\b/i.test(query),
              ),
            ).toHaveLength(1);
          } finally {
            sql.restore();
          }
          return { meta: { durationMs: 1 } };
        } finally {
          params.preparedRunAdmission.close();
        }
      },
    );
    await runSkillExperienceReview(candidate);
    expect(mocks.runSkillWorkshopReview).toHaveBeenCalledOnce();
  });

  it.each(["permission", "reset", "replacement", "deletion", "rewrite"] as const)(
    "refuses a Workshop file write after source %s during preparation",
    async (change) => {
      const candidate = await createExperienceReviewCandidate(
        `review-write-${change}`,
        [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
        { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
      );
      await upsertSessionEntryCore(candidate.source, {
        permissionMode: "guarded",
        lifecycleRevision: "original",
      });
      const context = { config: candidate.config, agentId: "main", actor: "review" as const };
      const original =
        "---\nname: procedure\ndescription: Follow the verified procedure\n---\n\nOriginal steps.\n";
      await createWorkshopSkill(context, { name: "procedure", content: original });
      const skillDir = path.join(resolveWorkshopSkillsDir(candidate.config, "main"), "procedure");
      let changed = false;
      const mkdir = fs.mkdir.bind(fs);
      const prepareFile = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === skillDir && !changed) {
          changed = true;
          if (change === "rewrite") {
            const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
            await session.removeTrailingEntriesAsync((entry) => entry.type === "message");
          } else {
            // Foreign commits bypass host publications after file preparation has yielded.
            const { DatabaseSync } = requireNodeSqlite();
            const writer = new DatabaseSync(candidate.source.storePath);
            try {
              if (change === "permission" || change === "reset") {
                writer
                  .prepare(
                    "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
                  )
                  .run(
                    change === "permission" ? "$.permissionMode" : "$.lifecycleRevision",
                    change === "permission" ? "read-only" : "reset-revision",
                    candidate.source.sessionKey,
                  );
              } else if (change === "deletion") {
                writer
                  .prepare("DELETE FROM session_nodes WHERE session_key = ?")
                  .run(candidate.source.sessionKey);
              } else {
                const replacement = `${candidate.source.sessionId}:replacement`;
                writer.exec("BEGIN IMMEDIATE");
                writer
                  .prepare(
                    "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) SELECT ?, session_key, session_scope, created_at, updated_at FROM session_windows WHERE session_id = ?",
                  )
                  .run(replacement, candidate.source.sessionId);
                writer
                  .prepare(
                    "UPDATE session_nodes SET current_session_id = ?, entry_json = json_set(entry_json, '$.sessionId', ?) WHERE session_key = ?",
                  )
                  .run(replacement, replacement, candidate.source.sessionKey);
                writer.exec("COMMIT");
              }
            } finally {
              writer.close();
            }
          }
        }
        return result;
      });
      mocks.runSkillWorkshopReview.mockImplementation(
        async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
          try {
            const admitted = await params.preparedRunAdmission.admit("embedded");
            const assertLive = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
            expect(assertLive).toBeDefined();
            await expect(
              writeWorkshopSkillFile(
                { ...context, assertLive },
                {
                  name: "procedure",
                  filePath: "SKILL.md",
                  content: original.replace("Original", "Changed"),
                },
              ),
            ).rejects.toThrow("no longer active");
            return { meta: { durationMs: 1 } };
          } finally {
            params.preparedRunAdmission.close();
          }
        },
      );
      try {
        await runSkillExperienceReview(candidate);
        expect(changed).toBe(true);
        expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(original);
      } finally {
        prepareFile.mockRestore();
      }
    },
  );
});
