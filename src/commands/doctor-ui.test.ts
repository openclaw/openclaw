import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../gateway/control-ui-root-assets.js";
import * as assets from "../infra/control-ui-assets.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as commands from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as version from "../version.js";
import { fixtureGit } from "./doctor-git.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  detectUiProtocolFreshnessIssues,
  maybeRepairUiProtocolFreshness,
  uiProtocolFreshnessIssueToHealthFinding,
  uiProtocolFreshnessIssueToRepairEffects,
} from "./doctor-ui.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

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

describe("UI repair", () => {
  const buildId = "doctor-runtime-build";
  const runtime = createTestRuntime();
  const prompter = createDoctorPrompter({ runtime, options: { yes: true, force: true } });
  let root: string;
  const repair = () => maybeRepairUiProtocolFreshness(runtime, prompter);
  const writeIndex = async (html: string) => {
    const index = path.join(root, "dist/control-ui/index.html");
    await fs.mkdir(path.dirname(index), { recursive: true });
    await fs.writeFile(index, html);
    return index;
  };

  beforeEach(async () => {
    root = await createOpenClawRoot();
    await touch(path.join(root, "ui/package.json"), new Date("2026-01-01"));
    vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
    vi.spyOn(packageRoot, "resolveOpenClawPackageRootSync").mockReturnValue(root);
    vi.spyOn(version, "resolveRuntimeServiceBuildId").mockReturnValue(buildId);
    vi.spyOn(notes, "note").mockImplementation(() => {});
    vi.spyOn(prompter, "confirmAutoFix").mockResolvedValue(true);
    vi.spyOn(prompter, "confirmAggressiveAutoFix").mockResolvedValue(true);
    vi.spyOn(assets, "ensureControlUiAssetsBuilt").mockImplementation(async (_runtime, opts) => {
      opts?.onBuildStart?.();
      return { ok: true, built: true };
    });
    mockGitLog("abc123 protocol schema changed\n");
  });

  it("routes missing app-owned assets to the host without package or git commands", async () => {
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "macos-app",
        displayName: "OpenClaw.app",
        updateHint: "Update OpenClaw.app to update this Gateway.",
      }),
    );
    await repair();
    expect(notes.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
      ),
      "UI",
    );
    for (const fn of [
      prompter.confirmAutoFix,
      prompter.confirmAggressiveAutoFix,
      assets.ensureControlUiAssetsBuilt,
      commands.runCommandWithTimeout,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("repairs source assets (protocol changed=%s)", async (force) => {
    await writeIndex(
      force
        ? `<html ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${buildId}-${"a".repeat(64)}"></html>`
        : '<script src="./assets/startup.js"></script>',
    );
    await repair();
    expect(prompter[force ? "confirmAggressiveAutoFix" : "confirmAutoFix"]).toHaveBeenCalledOnce();
    expect(assets.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(runtime, {
      root,
      expectedBuildId: buildId,
      force,
      onBuildStart: expect.any(Function),
    });
    expect(commands.runCommandWithTimeout).toHaveBeenCalledTimes(force ? 1 : 0);
    if (force) {
      expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
      expect(notes.note).toHaveBeenCalledWith("UI rebuild complete.", "UI");
      expect(notes.note).toHaveBeenCalledWith(expect.stringContaining("ui:build"), "UI Freshness");
    }
  });

  it.each(["incomplete", "markerless", "dev-build"])(
    "checks packaged UI identity without rebuilding it: %s",
    async (failure) => {
      const marker =
        failure === "dev-build" ? ` ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="dev-${"a".repeat(64)}"` : "";
      const html = `<html${marker}><script src="./assets/startup.js"></script></html>`;
      const indexPath = await writeIndex(html);
      if (failure !== "incomplete") {
        await fs.mkdir(path.join(path.dirname(indexPath), "assets"));
        await fs.writeFile(path.join(path.dirname(indexPath), "assets/startup.js"), "// startup");
      }
      await fs.rm(path.join(root, "ui/package.json"));
      await repair();
      if (failure === "dev-build") {
        expect(notes.note).not.toHaveBeenCalled();
      } else {
        expect(notes.note).toHaveBeenCalledWith(
          expect.stringContaining("Reinstall OpenClaw to restore bundled Control UI assets."),
          expect.any(String),
        );
      }
      expect(assets.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
      expect(commands.runCommandWithTimeout).not.toHaveBeenCalled();
      expect(await fs.readFile(indexPath, "utf8")).toBe(html);
    },
  );

  it("reports owner-normalized build failures instead of claiming repair success", async () => {
    vi.mocked(assets.ensureControlUiAssetsBuilt).mockResolvedValueOnce({
      ok: false,
      built: false,
      message: "Control UI build failed: spawn ENOENT",
    });
    await repair();
    expect(notes.note).toHaveBeenCalledWith("Control UI build failed: spawn ENOENT", "UI");
    expect(notes.note).not.toHaveBeenCalledWith("UI build complete.", "UI");
  });
});
