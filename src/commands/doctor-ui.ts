import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPathForRoot,
} from "../infra/control-ui-assets.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export type UiProtocolFreshnessIssue =
  | {
      readonly kind: "missing-assets";
      readonly root: string;
      readonly uiIndexPath: string;
      readonly canBuild: boolean;
    }
  | {
      readonly kind: "stale-assets";
      readonly root: string;
      readonly uiIndexPath: string;
      readonly changesSinceBuild: readonly string[];
      readonly canBuild: boolean;
    };

export async function detectUiProtocolFreshnessIssues(): Promise<
  readonly UiProtocolFreshnessIssue[]
> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return [];
  }

  const schemaPath = path.join(root, "packages/gateway-protocol/src/schema.ts");
  const uiHealth = await resolveControlUiDistIndexHealth({
    root,
    argv1: process.argv[1],
  });
  const uiIndexPath = uiHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(root);
  const uiSourcesPath = path.join(root, "ui/package.json");

  try {
    const [schemaStats, uiStats, uiSourcesStats] = await Promise.all([
      fs.stat(schemaPath).catch(() => null),
      fs.stat(uiIndexPath).catch(() => null),
      fs.stat(uiSourcesPath).catch(() => null),
    ]);
    if (!schemaStats) {
      return [];
    }
    const canBuild = uiSourcesStats !== null;
    if (!uiStats) {
      return [{ kind: "missing-assets", root, uiIndexPath, canBuild }];
    }
    if (schemaStats.mtime <= uiStats.mtime) {
      return [];
    }
    const gitLog = await runCommandWithTimeout(
      [
        "git",
        "-C",
        root,
        "log",
        `--since=${uiStats.mtime.toISOString()}`,
        "--format=%h %s",
        "packages/gateway-protocol/src/schema.ts",
      ],
      { timeoutMs: 5000 },
    ).catch(() => null);
    if (!gitLog || gitLog.code !== 0 || !gitLog.stdout.trim()) {
      return [];
    }
    return [
      {
        kind: "stale-assets",
        root,
        uiIndexPath,
        changesSinceBuild: gitLog.stdout.trim().split("\n"),
        canBuild,
      },
    ];
  } catch {
    return [];
  }
}

export function uiProtocolFreshnessIssueToHealthFinding(
  issue: UiProtocolFreshnessIssue,
): HealthFinding {
  return {
    checkId: "core/doctor/ui-protocol-freshness",
    severity: "warning",
    message: formatUiProtocolFreshnessIssue(issue),
    path: issue.uiIndexPath,
    fixHint: issue.canBuild
      ? "Run `openclaw doctor --fix` to build Control UI assets."
      : "Install from a source checkout with ui/ sources, then run `pnpm ui:build`.",
  };
}

export function uiProtocolFreshnessIssueToRepairEffects(
  issue: UiProtocolFreshnessIssue,
): readonly HealthRepairEffect[] {
  if (!issue.canBuild) {
    return [];
  }
  return [
    {
      kind: "process",
      action:
        issue.kind === "missing-assets" ? "would-build-control-ui" : "would-rebuild-control-ui",
      target: issue.root,
      dryRunSafe: false,
    },
  ];
}

function formatUiProtocolFreshnessIssue(issue: UiProtocolFreshnessIssue): string {
  if (issue.kind === "missing-assets") {
    return ["- Control UI assets are missing.", "- Run: pnpm ui:build"].join("\n");
  }
  return `UI assets are older than the protocol schema.\nFunctional changes since last build:\n${issue.changesSinceBuild
    .map((line) => `- ${line}`)
    .join("\n")}`;
}

export async function maybeRepairUiProtocolFreshness(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  for (const issue of await detectUiProtocolFreshnessIssues()) {
    if (issue.kind === "missing-assets") {
      note(formatUiProtocolFreshnessIssue(issue), "UI");
      if (!issue.canBuild) {
        note("Skipping UI build: ui/ sources not present.", "UI");
        continue;
      }
      const shouldRepair = await prompter.confirmAutoFix({
        message: "Build Control UI assets now?",
        initialValue: true,
      });
      if (shouldRepair) {
        note("Building Control UI assets... (this may take a moment)", "UI");
        const uiScriptPath = path.join(issue.root, "scripts/ui.js");
        const buildResult = await runCommandWithTimeout([process.execPath, uiScriptPath, "build"], {
          cwd: issue.root,
          timeoutMs: 120_000,
          env: { ...process.env, FORCE_COLOR: "1" },
        });
        if (buildResult.code === 0) {
          note("UI build complete.", "UI");
        } else {
          const details = [
            `UI build failed (exit ${buildResult.code ?? "unknown"}).`,
            buildResult.stderr.trim() ? buildResult.stderr.trim() : null,
          ]
            .filter(Boolean)
            .join("\n");
          note(details, "UI");
        }
      }
      continue;
    }

    note(formatUiProtocolFreshnessIssue(issue), "UI Freshness");
    const shouldRepair = await prompter.confirmAggressiveAutoFix({
      message: "Rebuild UI now? (Detected protocol mismatch requiring update)",
      initialValue: true,
    });
    if (shouldRepair) {
      if (!issue.canBuild) {
        note("Skipping UI rebuild: ui/ sources not present.", "UI");
        continue;
      }
      note("Rebuilding stale UI assets... (this may take a moment)", "UI");
      const uiScriptPath = path.join(issue.root, "scripts/ui.js");
      const buildResult = await runCommandWithTimeout([process.execPath, uiScriptPath, "build"], {
        cwd: issue.root,
        timeoutMs: 120_000,
        env: { ...process.env, FORCE_COLOR: "1" },
      });
      if (buildResult.code === 0) {
        note("UI rebuild complete.", "UI");
      } else {
        const details = [
          `UI rebuild failed (exit ${buildResult.code ?? "unknown"}).`,
          buildResult.stderr.trim() ? buildResult.stderr.trim() : null,
        ]
          .filter(Boolean)
          .join("\n");
        note(details, "UI");
      }
    }
  }
}
