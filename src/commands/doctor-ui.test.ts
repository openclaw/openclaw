import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as commands from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { fixtureGit } from "./doctor-git.test-support.js";
import {
  detectUiProtocolFreshnessIssues,
  uiProtocolFreshnessIssueToHealthFinding,
  uiProtocolFreshnessIssueToRepairEffects,
} from "./doctor-ui.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
type UiProtocolFreshnessIssue = Awaited<ReturnType<typeof detectUiProtocolFreshnessIssues>>[number];

function issue(overrides: Partial<UiProtocolFreshnessIssue> = {}): UiProtocolFreshnessIssue {
  return {
    kind: "missing-assets",
    root: "/repo/openclaw",
    uiIndexPath: "/repo/openclaw/dist/control-ui/index.html",
    canBuild: true,
    ...overrides,
  } as UiProtocolFreshnessIssue;
}

async function createOpenClawRoot(prefix = "openclaw-doctor-ui-"): Promise<string> {
  const root = await fs.realpath(tempRoots.make(prefix));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  return root;
}

async function touch(filePath: string, date: Date): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
  await fs.utimes(filePath, date, date);
}

function inspectRoot(root: string) {
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  return detectUiProtocolFreshnessIssues();
}

function mockGitLog(stdout: string | null) {
  const result = createCommandResult({ stdout: stdout ?? "", code: stdout === null ? 1 : 0 });
  vi.spyOn(commands, "runCommandWithTimeout").mockResolvedValue(result);
}

async function buildUi(root: string, date = "2026-01-01") {
  await touch(path.join(root, "ui/package.json"), new Date(date));
  await touch(path.join(root, "dist/control-ui/index.html"), new Date(date));
}

it.each(["missing-assets", "stale-assets"] as const)("maps %s findings/effects", (kind) => {
  const stale = kind === "stale-assets";
  const current = stale
    ? issue({ kind: "stale-assets", changesSinceBuild: ["abc123 schema change"] })
    : issue();
  expect(uiProtocolFreshnessIssueToHealthFinding(current)).toMatchObject({
    checkId: "core/doctor/ui-protocol-freshness",
    severity: "warning",
    path: "/repo/openclaw/dist/control-ui/index.html",
    fixHint: expect.stringContaining(`openclaw doctor --fix${stale ? " --force" : ""}`),
    ...(stale ? { message: expect.stringContaining("abc123 schema change") } : {}),
  });
  expect(uiProtocolFreshnessIssueToRepairEffects(current)).toEqual([
    {
      kind: "process",
      action: stale ? "would-rebuild-control-ui" : "would-build-control-ui",
      target: "/repo/openclaw",
      dryRunSafe: false,
    },
  ]);
});

it("passes the source root as one argument in the stale-assets manual repair", async () => {
  const root = await createOpenClawRoot("openclaw-doctor-ui-owner's source-");
  const unrelated = await createOpenClawRoot();
  await buildUi(root);
  vi.spyOn(process, "cwd").mockReturnValue(unrelated);
  mockGitLog("abc123 protocol changed");
  const findings = await inspectRoot(root);
  expect(findings).toEqual([expect.objectContaining({ kind: "stale-assets" })]);
  const finding = uiProtocolFreshnessIssueToHealthFinding(findings[0]!);
  const command = finding.fixHint?.match(/pnpm [^`\n]+/u)?.[0];
  expect(command).toBeDefined();
  const windows = process.platform === "win32";
  const captureArguments = windows
    ? `function pnpm { [Console]::Write(($args -join [char]0) + [char]0) }
${command!}`
    : `pnpm() { printf '%s\\0' "$@"; }
${command!}`;
  const output = execFileSync(
    windows ? "powershell.exe" : "/bin/sh",
    windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", captureArguments]
      : ["-c", captureArguments],
    { cwd: unrelated, timeout: 10_000, encoding: "utf8" },
  );
  expect(output.split("\0")).toEqual(["--dir", root, "ui:build", ""]);
});

it("gives packaged installs an actionable recovery hint instead of a missing build command", () => {
  const current = issue({ canBuild: false });
  const finding = uiProtocolFreshnessIssueToHealthFinding(current);
  expect(uiProtocolFreshnessIssueToRepairEffects(current)).toEqual([]);
  expect(finding.message).not.toContain("pnpm ui:build");
  expect(finding.fixHint).toContain("Reinstall OpenClaw");
});

it("reads committed nested protocol changes from the real complete-package git pathspec", async () => {
  const root = await createOpenClawRoot();
  await buildUi(root, "2026-01-02");
  await touch(
    path.join(root, "packages/gateway-protocol/src/schema/sessions.ts"),
    new Date("2026-01-03"),
  );
  const git = fixtureGit(root, {
    GIT_AUTHOR_DATE: "2026-01-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-03T00:00:00Z",
  });
  git("init", "--quiet");
  git("add", "packages/gateway-protocol/src/schema/sessions.ts");
  git("commit", "--quiet", "-m", "update nested protocol schema");
  await expect(inspectRoot(root)).resolves.toEqual([
    expect.objectContaining({
      kind: "stale-assets",
      changesSinceBuild: [expect.stringMatching(/update nested protocol schema$/)],
    }),
  ]);
});

it("does not report stale assets when git history is unavailable", async () => {
  const root = await createOpenClawRoot();
  await buildUi(root);
  await touch(path.join(root, "packages/gateway-protocol/src/schema.ts"), new Date("2026-01-02"));
  mockGitLog(null);
  await expect(inspectRoot(root)).resolves.toEqual([]);
});
