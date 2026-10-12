import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { runWithAgentToolSourceExecutionScope } from "../../agents/agent-tool-source-execution-guard.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
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
  it("announces changes committed before the review run failed", async () => {
    const workspaceDir = state.workspaceDir;
    const candidate = await createExperienceReviewCandidate(
      "review-fails-after-commit",
      [{ role: "user", content: "Reconcile the budget.", timestamp: 1 }],
      { workspaceDir, modelId: "gpt-test" },
    );
    setRuntimeConfigSnapshot(candidate.config);
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

  it("refreshes a later append without MAIN SQL and denies unprepared use after revocation", async () => {
    const candidate = await createExperienceReviewCandidate(
      "review-append",
      [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
      { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
    );
    setRuntimeConfigSnapshot(candidate.config);
    mocks.runSkillWorkshopReview.mockImplementation(
      async (params: Parameters<typeof runSkillWorkshopReview>[0]) => {
        try {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const assertCurrent = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
          expect(assertCurrent).toBeDefined();
          const session = await SessionManager.openAsync(candidate.source, state.workspaceDir);
          const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
          try {
            for (let index = 0; index < 5; index += 1) {
              assertCurrent!();
            }
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
          await session.appendMessageWithTranscriptAnchorAsync(
            { role: "user", content: "Continue the foreground task.", timestamp: 2 },
            { config: candidate.config },
          );
          const refreshedSql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
          try {
            await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
              assertCurrent!();
            });
            expect(refreshedSql.queries).toEqual([]);
          } finally {
            refreshedSql.restore();
          }
          await upsertSessionEntryCore(candidate.source, { permissionMode: "read-only" });
          // Provider dispatch checks the admitted assertion without preparing another scope.
          expect(() => assertCurrent!()).toThrow("no longer active");
          return { meta: { durationMs: 1 } };
        } finally {
          params.preparedRunAdmission.close();
        }
      },
    );
    await runSkillExperienceReview(candidate);
    expect(mocks.runSkillWorkshopReview).toHaveBeenCalledOnce();
  });

  it.each(["permission", "reset", "replacement", "deletion", "rewrite", "membership"] as const)(
    "refuses a Workshop file write after source %s during preparation",
    async (change) => {
      const candidate = await createExperienceReviewCandidate(
        `review-write-${change}`,
        [{ role: "user", content: "Remember the verified procedure.", timestamp: 1 }],
        { workspaceDir: state.workspaceDir, modelId: "gpt-test" },
      );
      setRuntimeConfigSnapshot(candidate.config);
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
          } else if (change === "membership") {
            await addSessionMember(candidate.source, {
              identityId: "new-member",
              addedBy: "owner",
              expectedSessionId: candidate.source.sessionId,
            });
          } else if (change === "deletion") {
            await deleteSessionEntryLifecycle({
              agentId: "main",
              storePath: candidate.source.storePath,
              target: {
                canonicalKey: candidate.source.sessionKey,
                storeKeys: [candidate.source.sessionKey],
              },
              archiveTranscript: false,
            });
          } else {
            await upsertSessionEntryCore(
              candidate.source,
              change === "permission"
                ? { permissionMode: "read-only" }
                : change === "reset"
                  ? { lifecycleRevision: "reset-revision" }
                  : { sessionId: `${candidate.source.sessionId}:replacement` },
            );
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
              runWithAgentToolSourceExecutionScope(assertLive, () =>
                writeWorkshopSkillFile(
                  { ...context, assertLive },
                  {
                    name: "procedure",
                    filePath: "SKILL.md",
                    content: original.replace("Original", "Changed"),
                  },
                ),
              ),
            ).rejects.toThrow("no longer active");
            await expect(
              runWithAgentToolSourceExecutionScope(assertLive, () =>
                writeWorkshopSkillFile(
                  { ...context, assertLive },
                  { name: "procedure", filePath: "SKILL.md", content: "must stay denied" },
                ),
              ),
            ).rejects.toThrow();
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
