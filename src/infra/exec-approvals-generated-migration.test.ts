import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { applyAllowAlwaysDecision } from "./exec-approvals-allow-always.js";
import {
  countObsoleteGeneratedExecApprovals,
  countObsoleteGeneratedExecApprovalRules,
  repairObsoleteGeneratedExecApprovals,
} from "./exec-approvals-generated-migration.js";
import { loadExecApprovalsReadOnly } from "./exec-approvals-store.js";
import {
  saveExecApprovals,
  testing as execApprovalsStoreTesting,
} from "./exec-approvals-store.test-support.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { buildCwdBoundHashedArgPattern } from "./exec-command-resolution.js";

const current = buildCwdBoundHashedArgPattern(["/usr/bin/git", "status"], "/workspace");
const generated = (pattern: string, argPattern?: string): ExecAllowlistEntry => ({
  pattern,
  source: "allow-always",
  ...(argPattern === undefined ? {} : { argPattern }),
});
const mainFile = (allowlist: ExecAllowlistEntry[]) => ({
  version: 1 as const,
  agents: { main: { allowlist } },
});

it("counts only the effective generated rules without changing whole-file diagnostics", () => {
  const effective = [generated("/usr/bin/old"), { pattern: "/usr/bin/manual" }];
  const unrelated = [generated("/usr/bin/other")];
  expect(countObsoleteGeneratedExecApprovalRules(effective)).toBe(1);
  expect(
    countObsoleteGeneratedExecApprovals({
      version: 1,
      agents: { main: { allowlist: effective }, other: { allowlist: unrelated } },
    }),
  ).toBe(2);
});

it("reapproval replaces obsolete grants for the same executable", () => {
  const updated = applyAllowAlwaysDecision({
    file: mainFile([generated("/usr/bin/git", "sha256:argv:obsolete"), generated("/usr/bin/curl")]),
    agentId: "main",
    decision: {
      kind: "patterns",
      patterns: [{ pattern: "/usr/bin/git", argPattern: current }],
    },
  });

  expect(updated?.agents?.main?.allowlist).toEqual([
    { pattern: "/usr/bin/curl", source: "allow-always" },
    expect.objectContaining(generated("/usr/bin/git", current)),
  ]);
});

it("removes inactive generated grants without changing manual or cwd-bound rules", async () => {
  await withTestDir({ prefix: "openclaw-exec-approval-migration-" }, async (home) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    closeOpenClawStateDatabaseForTest();
    execApprovalsStoreTesting.reset();
    try {
      const file = mainFile([
        generated("/usr/bin/git"),
        generated("/usr/bin/curl", "sha256:argv:obsolete"),
        generated("C:\\Tools\\rg.exe", "^--json\0$"),
        generated("/usr/bin/git", current),
        { pattern: "/usr/bin/python3", argPattern: "^script\\.py$" },
        { pattern: "/usr/bin/node", argPattern: "sha256:argv:obsolete" },
        { pattern: "=node-command:marker", source: "allow-always" },
      ]);
      saveExecApprovals(file);

      expect(countObsoleteGeneratedExecApprovals(loadExecApprovalsReadOnly())).toBe(3);
      expect(repairObsoleteGeneratedExecApprovals()).toBe(3);
      expect(loadExecApprovalsReadOnly().agents?.main?.allowlist).toEqual([
        expect.objectContaining(generated("/usr/bin/git", current)),
        expect.objectContaining({ pattern: "/usr/bin/python3", argPattern: "^script\\.py$" }),
        // Inactive but manual: Doctor never deletes what allow-always did not write.
        expect.objectContaining({ pattern: "/usr/bin/node", argPattern: "sha256:argv:obsolete" }),
        expect.objectContaining({ pattern: "=node-command:marker", source: "allow-always" }),
      ]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      vi.unstubAllEnvs();
    }
  });
});
