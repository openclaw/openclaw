import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { gitEnvironment } from "../agents/worktrees/git.js";
import type { OpenClawConfig } from "../config/config.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { executeGitCommand, requireGitCommandOutput } from "../infra/git-exec.js";
import {
  ProjectCheckoutBusyError,
  withProjectCheckoutLifecycle,
} from "../projects/project-checkout.js";
import { listProjectRegistry } from "../projects/project-registry.js";

const CHECK_ID = "core/doctor/project-clone-shape";

type CloneShapeOptions = { repair?: boolean; env?: NodeJS.ProcessEnv };

export async function collectProjectCloneShapeHealthFindings(
  cfg: OpenClawConfig,
  options: CloneShapeOptions = {},
): Promise<readonly HealthFinding[]> {
  const env = options.env ?? process.env;
  const findings: HealthFinding[] = [];
  const report = (finding: Omit<HealthFinding, "checkId">) =>
    findings.push({
      checkId: CHECK_ID,
      category: "recommended",
      docsUrl: "https://docs.openclaw.ai/cli/doctor/checks",
      ...finding,
    });
  let projects;
  try {
    projects = (await listProjectRegistry(cfg, { env })).filter(
      (project) => project.source === "cloned",
    );
  } catch {
    report({
      severity: "warning",
      category: "fix-now",
      message: "Skipped project clone inspection: the project registry is unreadable.",
      fixHint: "Restore access to the project registry and rerun openclaw doctor.",
    });
    return findings;
  }
  for (const project of projects) {
    const label = `Project clone ${project.displayName} (${project.id})`;
    let fetching = false;
    try {
      const inspect = async (lease?: { signal: AbortSignal; assertCurrent(): void }) => {
        const gitDir = path.join(project.repoRoot, ".git");
        if (!(await fs.readdir(gitDir)).includes("shallow")) {
          return;
        }
        const packs = (await fs.readdir(path.join(gitDir, "objects", "pack"))).filter((name) =>
          name.endsWith(".pack"),
        ).length;
        const followUp =
          packs >= 1_000
            ? ` ${packs} packs: ask the operator to run a separate bounded repack under the project checkout lifecycle lease; Doctor does not repack.`
            : "";
        if (lease) {
          fetching = true;
          requireGitCommandOutput(
            "git fetch --unshallow",
            await executeGitCommand(
              project.repoRoot,
              [
                "fetch",
                "--unshallow",
                "--filter=blob:none",
                "--no-auto-maintenance",
                "--no-prune",
                "--no-prune-tags",
                "--no-tags",
                "--no-write-fetch-head",
                "--no-recurse-submodules",
                "origin",
              ],
              {
                env: gitEnvironment({ ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }),
                timeoutMs: 30 * 60_000,
                maxOutputBytes: 64 * 1024,
                lowerPriority: true,
                killProcessTree: true,
                signal: lease.signal,
                beforeRun: () => lease.assertCurrent(),
              },
            ),
          );
          // A shallow origin can make --unshallow exit zero with incomplete history.
          const stillShallow = (await fs.readdir(gitDir)).includes("shallow");
          report({
            severity: stillShallow ? "warning" : "info",
            path: project.repoRoot,
            message: stillShallow
              ? `${label}: still shallow; origin may not have complete history. Restore access to a full-history origin and rerun openclaw doctor --fix.${followUp}`
              : `${label}: unshallowed; blob filtering and existing objects retained.${followUp}`,
          });
        } else {
          report({
            severity: "warning",
            path: project.repoRoot,
            message: `${label}: shallow history can cause repeated downloads in partial clones.${followUp}`,
            fixHint: "Run openclaw doctor --fix to fetch full history while retaining blob:none.",
          });
        }
      };
      if (options.repair) {
        await withProjectCheckoutLifecycle(project.repoRoot, { env, waitMs: 0 }, inspect);
      } else {
        await inspect();
      }
    } catch (error) {
      report({
        severity: "warning",
        category: "fix-now",
        path: project.repoRoot,
        message:
          error instanceof ProjectCheckoutBusyError
            ? `${label}: busy; skipped. Rerun openclaw doctor --fix when checkout work finishes.`
            : fetching
              ? `${label}: unshallow failed or timed out. Check origin access, network, and disk space, then rerun openclaw doctor --fix.`
              : `${label}: skipped; repository is missing or unreadable. Check the clone path and permissions.`,
      });
    }
  }
  return findings;
}

export async function noteProjectCloneShape(
  cfg: OpenClawConfig,
  options: CloneShapeOptions = {},
): Promise<void> {
  for (const finding of await collectProjectCloneShapeHealthFindings(cfg, options)) {
    note(
      [finding.message, finding.path, finding.fixHint].filter(Boolean).join("\n"),
      "Project clones",
    );
  }
}
