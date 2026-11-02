import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";

const runCommandWithTimeoutMock = vi.fn();
const installPluginFromInstalledPackageDirMock = vi.fn();
const preflightPluginGitInstallPolicyMock = vi.fn();
const demoSpec = "git:github.com/acme/demo";
const clonePrefix = ["git", "clone", "--no-hardlinks"];

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./install.js", async () => {
  const actual = await vi.importActual<typeof import("./install.js")>("./install.js");
  return {
    ...actual,
    installPluginFromInstalledPackageDir: (...args: unknown[]) =>
      installPluginFromInstalledPackageDirMock(...args),
  };
});

vi.mock("./install-security-scan.js", async () => {
  const actual = await vi.importActual<typeof import("./install-security-scan.js")>(
    "./install-security-scan.js",
  );
  return {
    ...actual,
    preflightPluginGitInstallPolicy: (...args: unknown[]) =>
      preflightPluginGitInstallPolicyMock(...args),
  };
});

vi.resetModules();

const { installPluginFromGitSpec, parseGitPluginSpec } = await import("./git-install.js");
const { onInternalDiagnosticEvent } = await import("../infra/diagnostic-events.js");
const install = (options: Partial<Parameters<typeof installPluginFromGitSpec>[0]> = {}) =>
  installPluginFromGitSpec({ spec: demoSpec, ...options });
const read = (dir: string, name: string) => fs.readFile(path.join(dir, name), "utf8");
const normalizedDemoSpec = "git:https://github.com/acme/demo.git";

function expectedGitRepoDir(gitDir: string, normalizedSpec: string): string {
  const hash = createHash("sha256")
    .update(redactSensitiveUrlLikeString(normalizedSpec))
    .digest("hex")
    .slice(0, 16);
  return path.join(gitDir, `git-${hash}`, "repo");
}

function expectParsedGitSpec(spec: string) {
  return expectDefined(parseGitPluginSpec(spec), `git plugin spec: ${spec}`);
}
function commandArgvAt(index: number): string[] {
  const call = expectDefined(runCommandWithTimeoutMock.mock.calls[index], `command #${index + 1}`);
  return call[0] as string[];
}
const cloneDestination = () =>
  path.resolve(expectDefined(commandArgvAt(0).at(-1), "clone destination"));

function firstInstallOptions() {
  return installPluginFromInstalledPackageDirMock.mock.calls[0]?.[0] as
    | Parameters<typeof import("./install.js").installPluginFromInstalledPackageDir>[0]
    | undefined;
}

type GitResult = Awaited<ReturnType<typeof installPluginFromGitSpec>>;
function expectSuccess(result: GitResult): asserts result is Extract<GitResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
}
function expectFailure(
  result: GitResult,
  message: string,
): asserts result is Extract<GitResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected failed git install");
  }
  expect(result.error).toContain(message);
}

function mockGitCommands(...outputs: Array<string | { code: number; stderr: string }>) {
  for (const output of outputs) {
    runCommandWithTimeoutMock.mockResolvedValueOnce(
      typeof output === "string"
        ? { code: 0, stdout: output, stderr: "" }
        : { stdout: "", ...output },
    );
  }
}

function mockSuccessfulPackageInstall(
  files: Record<string, string> = {},
  version: string | null = "1.2.3",
) {
  installPluginFromInstalledPackageDirMock.mockImplementation(
    async ({ packageDir }: { packageDir: string }) => {
      await fs.mkdir(packageDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(packageDir, name), content);
      }
      return packageInstallResult(packageDir, version);
    },
  );
}

function packageInstallResult(targetDir: string, version: string | null = "1.2.3") {
  return {
    ok: true,
    pluginId: "demo",
    targetDir,
    ...(version ? { version } : {}),
    extensions: ["index.js"],
  };
}

function mockPreparedInstall(files: Record<string, string> = {}, version: string | null = "1.2.3") {
  mockGitCommands("", "abc123\n", "");
  mockSuccessfulPackageInstall(files, version);
}

async function installWithSecurityEvents(options: Parameters<typeof installPluginFromGitSpec>[0]) {
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  try {
    return { result: await installPluginFromGitSpec(options), events };
  } finally {
    stop();
  }
}

describe("parseGitPluginSpec", () => {
  it.each([
    ["git:github.com/acme/demo@v1.2.3", "v1.2.3"],
    ["git:acme/demo@feature/foo", "feature/foo"],
    ["git:acme/demo#main", "main"],
  ])("normalizes GitHub shorthand and ref selectors: %s", (spec, ref) => {
    expect(expectParsedGitSpec(spec)).toMatchObject({
      url: "https://github.com/acme/demo.git",
      ref,
      label: "acme/demo",
      normalizedSpec: `git:https://github.com/acme/demo.git@${ref}`,
    });
  });

  it("keeps scp-style clone URLs without treating git@ as a ref", () => {
    expect(expectParsedGitSpec("git:git@github.com:acme/demo.git@feature/foo")).toMatchObject({
      url: "git@github.com:acme/demo.git",
      ref: "feature/foo",
      label: "git@github.com:acme/demo",
    });
  });
});

describe("installPluginFromGitSpec", () => {
  let state: OpenClawTestState;
  const trackedTempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(async () => {
    runCommandWithTimeoutMock.mockReset();
    installPluginFromInstalledPackageDirMock.mockReset();
    preflightPluginGitInstallPolicyMock.mockReset();
    preflightPluginGitInstallPolicyMock.mockResolvedValue(null);
    state = await createOpenClawTestState({ label: "git-install" });
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it("rejects option-leading clone sources before invoking git", async () => {
    const result = await install({ spec: "git:--upload-pack=/tmp/pwn.git", dryRun: true });

    expect(result).toEqual({
      ok: false,
      error: "unsupported git: plugin spec: git:--upload-pack=/tmp/pwn.git",
    });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([
    ["install", undefined, undefined, 120_000, 300_000],
    ["update", undefined, undefined, undefined, undefined],
    ["update", 50, undefined, 50, 50],
    ["update", 500, null, undefined, undefined],
  ] as const)(
    "acquires and installs in %s mode with timeout %s and work timeout %s, preserving bounded ref probes",
    async (mode, timeoutMs, workTimeoutMs, gitWork, npmWork) => {
      mockGitCommands("", "abc123\n", "", "abc123\n", "");
      mockSuccessfulPackageInstall();

      const { result, events } = await installWithSecurityEvents({
        spec: "git:github.com/acme/demo@v1.2.3",
        expectedPluginId: "demo",
        mode,
        timeoutMs,
        workTimeoutMs,
      });

      expectSuccess(result);
      expect(result).toMatchObject({
        pluginId: "demo",
        git: { url: "https://github.com/acme/demo.git", ref: "v1.2.3", commit: "abc123" },
      });
      const cloneArgv = commandArgvAt(0);
      expect(cloneArgv.slice(0, 5)).toEqual([
        ...clonePrefix,
        "--",
        "https://github.com/acme/demo.git",
      ]);
      expect(cloneArgv[5]).toContain("/.openclaw-install-stage-");
      expect(commandArgvAt(4)).toContain("--ignore-scripts");
      expect(runCommandWithTimeoutMock.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([
        gitWork,
        timeoutMs ?? 120_000,
        gitWork,
        timeoutMs ?? 120_000,
        npmWork,
      ]);
      expect(firstInstallOptions()).toMatchObject({
        expectedPluginId: "demo",
        packageDir: cloneArgv[5],
        installPolicyRequest: {
          kind: "plugin-git",
          requestedSpecifier: "git:github.com/acme/demo@v1.2.3",
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "plugin.installed",
        outcome: "success",
        target: { kind: "plugin", name: "demo" },
        attributes: {
          source_family: "git",
          mode: "install",
          extension_count: 1,
          has_version: true,
        },
      });
    },
  );

  it("does not emit git install success when committing the managed repo fails", async () => {
    const gitRoot = trackedTempDirs.make("openclaw-git-install-fail-");
    const gitDir = path.join(gitRoot, "not-a-directory");
    await fs.writeFile(gitDir, "file blocks nested managed repo creation", "utf8");
    mockPreparedInstall({ "package.json": "{}" });
    const { result, events } = await installWithSecurityEvents({ spec: demoSpec, gitDir });

    expectFailure(result, "failed to replace managed git plugin repository");
    expect(events).toHaveLength(0);
  });

  it.each([
    {
      code: "security_scan_blocked",
      reason: "blocked by install policy: git installs disabled",
      spec: demoSpec,
      expectedPluginId: "demo",
      outcome: "denied",
    },
    {
      code: "security_scan_failed",
      reason: "install policy unavailable",
      spec: "git:file:///Users/example/private-plugin",
      expectedPluginId: undefined,
      outcome: "error",
    },
    {
      code: undefined,
      reason: "blocked without a terminal code",
      spec: demoSpec,
      expectedPluginId: "demo",
      outcome: "denied",
    },
  ])(
    "reports $outcome preflight without installing dependencies",
    async ({ code, reason, spec, expectedPluginId, outcome }) => {
      mockGitCommands("", "abc123\n");
      preflightPluginGitInstallPolicyMock.mockResolvedValueOnce({
        blocked: {
          reason,
          code,
          installPolicyWarning: {
            reason,
            targetName: "demo",
            targetType: "plugin",
            requestMode: "install",
          },
        },
      });
      const { result, events } = await installWithSecurityEvents({ spec, expectedPluginId });
      expectFailure(result, reason);
      expect(result).toEqual({ ok: false, error: reason, ...(code ? { code } : {}) });
      if (expectedPluginId) {
        expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
        expect(preflightPluginGitInstallPolicyMock).toHaveBeenCalledWith(
          expect.objectContaining({
            pluginId: "demo",
            requestedSpecifier: demoSpec,
            source: { kind: "git", authority: "third-party", mutable: true, network: true },
            sourcePath: expect.stringContaining("/.openclaw-install-stage-"),
          }),
        );
      }
      expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "plugin.audit.failed",
        outcome,
        target: { kind: "plugin", ...(expectedPluginId ? { name: expectedPluginId } : {}) },
        attributes: { source_family: "git", mode: "install" },
      });
      if (!expectedPluginId) {
        expect(events[0]?.target).not.toHaveProperty("name");
      }
    },
  );

  it("reports full commit refs as immutable to install policy", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    mockGitCommands("", `${commit}\n`, "", `${commit}\n`, "");
    mockSuccessfulPackageInstall();

    const result = await installPluginFromGitSpec({
      spec: `git:github.com/acme/demo@${commit}`,
      expectedPluginId: "demo",
    });

    expect(result.ok).toBe(true);
    expect(preflightPluginGitInstallPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedSpecifier: `git:github.com/acme/demo@${commit}`,
        source: { kind: "git", authority: "third-party", mutable: false, network: true },
      }),
    );
  });

  it.each(["git:github.com/acme/demo", "git:https://token@github.com/acme/demo.git"])(
    "uses credential-free same-filesystem staging for %s (#99885)",
    async (spec) => {
      const gitDir = trackedTempDirs.make("openclaw-git-install-stage-");
      mockPreparedInstall();
      const result = await install({ spec, gitDir });
      expectSuccess(result);

      const cloneDest = cloneDestination();
      const normalizedSpec = spec === demoSpec ? normalizedDemoSpec : spec;
      const persistentRepoDir = expectedGitRepoDir(gitDir, normalizedSpec);
      const cloneParent = await fs.realpath(path.dirname(path.resolve(cloneDest)));
      const targetParent = await fs.realpath(path.dirname(persistentRepoDir));
      expect(cloneParent).toBe(targetParent);
      expect(result.targetDir).toBe(persistentRepoDir);
      expect(result.targetDir).not.toContain("token");
      expect(result.targetDir).not.toContain("github.com");
    },
  );

  it("reviews the final prepared artifact before publishing a deferred git install", async () => {
    const gitDir = trackedTempDirs.make("openclaw-git-consent-stage-");
    mockPreparedInstall({ "index.js": "reviewed capabilities" }, null);
    let reviewedArtifactDir: string | undefined;

    const result = await install(
      requestDeferredPluginInstall({
        gitDir,
        onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
          reviewedArtifactDir = stagedArtifactDir;
          await expect(read(stagedArtifactDir, "index.js")).resolves.toBe("reviewed capabilities");
        },
      }),
    );

    expectSuccess(result);
    expect(reviewedArtifactDir).toBe(firstInstallOptions()?.packageDir);
    expect(
      path.basename(expectDefined(reviewedArtifactDir, "reviewed artifact test invariant")),
    ).toMatch(/^\.openclaw-install-stage-/);
    await expect(read(result.targetDir, "index.js")).resolves.toBe("reviewed capabilities");
    await resolvePluginInstallTransaction(result)?.commit();
  });

  it("preserves a deferred git consent rejection without publishing its staged artifact", async () => {
    const gitDir = trackedTempDirs.make("openclaw-git-consent-rejection-");
    mockPreparedInstall({}, null);
    const consentRejection = new Error("plugin capabilities require review");

    await expect(
      install(
        requestDeferredPluginInstall({
          gitDir,
          onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
            expect(stagedArtifactDir).toBe(firstInstallOptions()?.packageDir);
            throw consentRejection;
          },
        }),
      ),
    ).rejects.toBe(consentRejection);
    await expect(fs.access(expectedGitRepoDir(gitDir, normalizedDemoSpec))).rejects.toThrow();
  });

  it("keeps dry-run clone staging out of managed state", async () => {
    const caseDir = trackedTempDirs.make("openclaw-git-dry-run-stage-");
    const gitDir = path.join(caseDir, "git");
    mockGitCommands("", "abc123\n");
    installPluginFromInstalledPackageDirMock.mockImplementation(
      async ({ packageDir }: { packageDir: string }) => packageInstallResult(packageDir),
    );

    const result = await install({ gitDir, dryRun: true });

    expect(result.ok).toBe(true);
    const cloneDest = cloneDestination();
    expect(path.relative(gitDir, cloneDest).split(path.sep)[0]).toBe("..");
    await expect(fs.access(gitDir)).rejects.toThrow();
  });

  it("redacts authenticated git URLs from command failure details", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr:
        "fatal: could not read Username for 'https://token:secret@github.com/acme/demo.git' while retrying https://other:credential@github.com/acme/fallback.git",
    });

    const result = await install({ spec: "git:https://token:secret@github.com/acme/demo.git" });

    expectFailure(result, "failed to clone github.com/acme/demo");
    expect(result.error).toContain("https://***:***@github.com/acme/demo.git");
    expect(result.error).toContain("https://***:***@github.com/acme/fallback.git");
    expect(result.error).not.toMatch(/token|secret|other|credential/);
    expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
  });

  it("separates requested refs from git options", async () => {
    mockGitCommands("", { code: 1, stderr: "" }, { code: 1, stderr: "" });

    const result = await install({ spec: "git:github.com/acme/demo@--ignore-skip-worktree-bits" });

    expect(result.ok).toBe(false);
    const refProbe = ["git", "rev-parse", "--verify", "--quiet"];
    expect(commandArgvAt(1)).toEqual([...refProbe, "--ignore-skip-worktree-bits^{commit}"]);
    expect(commandArgvAt(2)).toEqual([...refProbe, "origin/--ignore-skip-worktree-bits^{commit}"]);
    expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
  });

  it("keeps the existing managed repo when replacement install fails", async () => {
    const gitDir = trackedTempDirs.make("openclaw-git-install-preserve-");
    const existingRepoDir = expectedGitRepoDir(gitDir, normalizedDemoSpec);
    const markerPath = path.join(existingRepoDir, "existing.txt");
    await fs.mkdir(existingRepoDir, { recursive: true });
    await fs.writeFile(markerPath, "keep");
    mockGitCommands("", "abc123\n", { code: 1, stderr: "npm failed" });

    const result = await install({ spec: normalizedDemoSpec, gitDir, mode: "update" });

    expectFailure(result, "npm install failed");
    await expect(read(existingRepoDir, "existing.txt")).resolves.toBe("keep");
    expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
  });
});
