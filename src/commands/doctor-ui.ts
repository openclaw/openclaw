import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import {
  ensureControlUiAssetsBuilt,
  formatControlUiSourceCommand,
  resolveControlUiAssetHealth,
  resolveControlUiDistIndexPathForRoot,
} from "../infra/control-ui-assets.js";
import {
  formatInstallOwnerMessage,
  readInstallOwner,
  type InstallOwner,
} from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type UiProtocolFreshnessIssue = {
  readonly root: string;
  readonly uiIndexPath: string;
  readonly canBuild: boolean;
  readonly installOwner?: InstallOwner;
} & (
  | { readonly kind: "missing-assets" }
  | { readonly kind: "stale-assets"; readonly changesSinceBuild: readonly string[] }
);

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
  const installOwner = await readInstallOwner(root);

  // Doctor checks its loaded install; updater callers may inspect a newer target build.
  const uiHealth = await resolveControlUiAssetHealth({
    root,
    expectedBuildId: resolveRuntimeServiceBuildId(),
  });
  const uiIndexPath = uiHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(root);

  try {
    const canBuild =
      !installOwner &&
      (await fs.stat(path.join(root, "ui/package.json")).then(
        () => true,
        () => false,
      ));
    const issue = { root, uiIndexPath, canBuild, ...(installOwner ? { installOwner } : {}) };
    if (uiHealth.kind !== "ready") {
      return [
        uiHealth.kind === "stale"
          ? { ...issue, kind: "stale-assets", changesSinceBuild: [] }
          : { ...issue, kind: "missing-assets" },
      ];
    }
    if (!canBuild) {
      return [];
    }
    const uiMtime = (await fs.stat(uiIndexPath)).mtime;
    const gitLog = await runCommandWithTimeout(
      [
        "git",
        "-C",
        root,
        "log",
        `--since=${uiMtime.toISOString()}`,
        "--format=%h %s",
        "packages/gateway-protocol/src",
      ],
      { timeoutMs: 5000 },
    );
    const output = gitLog.code === 0 ? gitLog.stdout.trim() : "";
    if (!output) {
      return [];
    }
    return [{ ...issue, kind: "stale-assets", changesSinceBuild: output.split("\n") }];
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
    category: "fix-now",
    docsUrl: "https://docs.openclaw.ai/web/control-ui",
    message: formatUiProtocolFreshnessIssue(issue),
    path: issue.uiIndexPath,
    fixHint: issue.installOwner
      ? formatInstallOwnerMessage(issue.installOwner)
      : issue.canBuild
        ? issue.kind === "missing-assets"
          ? "Run `openclaw doctor --fix` to build Control UI assets."
          : `Run \`openclaw doctor --fix --force\` to rebuild Control UI assets, or run \`${formatControlUiSourceCommand(issue.root, "build")}\`.`
        : "Reinstall OpenClaw to restore bundled Control UI assets.",
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
  const message =
    issue.kind === "missing-assets"
      ? "- Control UI assets are missing or incomplete."
      : issue.changesSinceBuild.length === 0
        ? "Control UI assets do not match the current Gateway build."
        : `UI assets are older than the protocol schema.\nFunctional changes since last build:\n${issue.changesSinceBuild.map((line) => `- ${line}`).join("\n")}`;
  return [
    message,
    issue.installOwner
      ? formatInstallOwnerMessage(issue.installOwner)
      : issue.canBuild
        ? `- Run: ${formatControlUiSourceCommand(issue.root, "build")}`
        : "- Reinstall OpenClaw to restore bundled Control UI assets.",
  ].join("\n");
}

export async function maybeRepairUiProtocolFreshness(
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  for (const issue of await detectUiProtocolFreshnessIssues()) {
    const stale = issue.kind === "stale-assets";
    note(formatUiProtocolFreshnessIssue(issue), stale ? "UI Freshness" : "UI");
    if (issue.installOwner) {
      continue;
    }
    if (!issue.canBuild) {
      note(`Skipping UI ${stale ? "rebuild" : "build"}: ui/ sources not present.`, "UI");
      continue;
    }
    const shouldRepair = await prompter[stale ? "confirmAggressiveAutoFix" : "confirmAutoFix"]({
      message: stale ? "Rebuild stale Control UI assets now?" : "Build Control UI assets now?",
      initialValue: true,
    });
    if (!shouldRepair) {
      continue;
    }
    const result = await ensureControlUiAssetsBuilt(runtime, {
      root: issue.root,
      expectedBuildId: resolveRuntimeServiceBuildId(),
      force: stale,
      onBuildStart: () =>
        note(
          `${stale ? "Rebuilding stale" : "Building Control"} UI assets... (this may take a moment)`,
          "UI",
        ),
    });
    note(
      result.ok
        ? `UI ${stale ? "rebuild" : "build"} complete.`
        : (result.message ?? `UI ${stale ? "rebuild" : "build"} failed.`),
      "UI",
    );
  }
}
