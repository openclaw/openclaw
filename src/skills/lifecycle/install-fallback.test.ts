import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBrewExecutable } from "../../infra/brew.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, withEnvAsync } from "../../test-utils/env.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { hasBinary } from "../loading/config.js";
import {
  hasBinaryMock,
  runCommandWithTimeoutMock as runCommand,
} from "../test-support/install-test-mocks.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";
import { installSkill, resolveInstallerKindReadiness } from "./install.js";

const skillsMocks = vi.hoisted(() => ({
  loadWorkspaceSkills: vi.fn(),
}));

// mock-isolation: Keep package-manager commands synthetic; never invoke host installers.
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: vi.fn(async () => undefined),
}));

vi.mock("../loading/workspace-skill-loader.js", () => {
  return {
    prepareWorkspaceSkills: skillsMocks.loadWorkspaceSkills,
  };
});

vi.mock("../loading/config.js", { spy: true });
vi.mock("../../infra/brew.js", { spy: true });
vi.mock("../../infra/container-environment.js", { spy: true });

function makeSkillEntry(
  workspaceDir: string,
  name: string,
  installSpec: SkillInstallSpec,
): SkillEntry {
  const skillDir = path.join(workspaceDir, "skills", name);
  return {
    skill: {
      name,
      description: "test skill",
      filePath: path.join(skillDir, "SKILL.md"),
      baseDir: skillDir,
      source: "openclaw-workspace",
    } as SkillEntry["skill"],
    frontmatter: {},
    metadata: {
      install: [{ id: "deps", ...installSpec }],
    },
  };
}

function mockAvailableBinaries(binaries: string[]) {
  const available = new Set(binaries);
  hasBinaryMock.mockImplementation((bin: string) => available.has(bin));
}

function assertNoAptGetFallbackCalls() {
  const aptCalls = runCommand.mock.calls.filter((call) => {
    if (!Array.isArray(call[0])) {
      return false;
    }
    const argv = call[0] as string[];
    const isPermissionCheck =
      argv[0] === "sudo" && argv.some((arg) => arg === "-l" || arg === "-ll");
    return argv.includes("apt-get") && !isPermissionCheck;
  });
  expect(aptCalls).toHaveLength(0);
}

function mockPasswordlessSudoRule(): void {
  reply("    Options: !authenticate\n");
}

type CommandCall = [
  string[],
  { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; timeoutMs?: number },
];
function commandCallAt(index: number): CommandCall {
  const call = runCommand.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected command call ${index}`);
  }
  return call as CommandCall;
}

function expectLocalGoVersionEnvCall(index: number): void {
  const [argv, options] = commandCallAt(index);
  expect(argv).toEqual(["go", "env", "GOVERSION"]);
  expect(options.timeoutMs).toBe(5_000);
  expect(options.env).toEqual({ GOTOOLCHAIN: "local" });
}

function withUid<T>(uid: number, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(process, "getuid").mockReturnValue(uid);
  return fn().finally(() => spy.mockRestore());
}

function reply(stdout = "", code = 0, stderr = "") {
  return runCommand.mockResolvedValueOnce({ code, stdout, stderr });
}
function completed(stdout = "ok", code = 0, stderr = "") {
  return { code, stdout, stderr, signal: null, killed: false };
}

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-fallback-test-" });

describe("skills-install fallback edge cases", () => {
  let workspaceDir: string;
  const install = (
    skillName = "go-tool-single",
    options: Partial<Parameters<typeof installSkill>[0]> = {},
  ) => installSkill({ workspaceDir, skillName, installId: "deps", ...options });
  let installEnvSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    workspaceDir = await suiteTempDirs.setup();
    skillsMocks.loadWorkspaceSkills.mockReturnValue([
      makeSkillEntry(workspaceDir, "go-tool-single", {
        kind: "go",
        module: "example.com/tool@latest",
      }),
      makeSkillEntry(workspaceDir, "py-tool", {
        kind: "uv",
        package: "example-package",
      }),
    ]);
  });

  beforeEach(() => {
    installEnvSnapshot = captureEnv(["PATH", "GOBIN", "GOPATH"]);
    runCommand.mockReset();
    hasBinaryMock.mockReset();
    vi.mocked(hasBinary)
      .mockReset()
      .mockImplementation((bin: string) => hasBinaryMock(bin));
    vi.mocked(resolveBrewExecutable).mockReset().mockReturnValue(undefined);
    vi.mocked(isContainerEnvironment).mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    installEnvSnapshot.restore();
  });

  afterAll(async () => {
    vi.mocked(hasBinary).mockReset();
    vi.mocked(resolveBrewExecutable).mockReset();
    vi.mocked(isContainerEnvironment).mockReset();
    await suiteTempDirs.cleanup();
  });

  it("handles sudo probe failures for go install without apt fallback", async () => {
    await withUid(1000, async () => {
      for (const testCase of [
        {
          label: "sudo returns password required",
          setup: () => reply("", 1, "sudo: a password is required"),
          stderr: "sudo: a password is required",
        },
        {
          label: "sudo probe throws executable-not-found",
          setup: () =>
            runCommand.mockRejectedValueOnce(new Error('Executable not found in $PATH: "sudo"')),
          stderr: "Executable not found",
        },
      ]) {
        runCommand.mockClear();
        mockAvailableBinaries(["apt-get", "sudo"]);
        testCase.setup();

        const result = await install();

        expect(result.ok, testCase.label).toBe(false);
        expect(result.message).toContain("sudo is not usable");
        expect(result.message).toContain("https://go.dev/doc/install");
        expect(result.stderr).toContain(testCase.stderr);
        const sudoCall = commandCallAt(0);
        expect(sudoCall[0], testCase.label).toEqual([
          "sudo",
          "-k",
          "-n",
          "-ll",
          "apt-get",
          "update",
          "-qq",
        ]);
        expect(sudoCall?.[1]?.timeoutMs, testCase.label).toBe(5_000);
        expect(sudoCall?.[1]?.env, testCase.label).toEqual({ LC_ALL: "C" });
        assertNoAptGetFallbackCalls();
      }
    });
  });

  it("rejects an apt rule that requires authentication even when sudo listing succeeds", async () => {
    await withUid(1000, async () => {
      mockAvailableBinaries(["apt-get", "sudo"]);
      mockPasswordlessSudoRule();
      reply("    Options: authenticate\n");

      const result = await install();

      expect(result.ok).toBe(false);
      expect(commandCallAt(0)[0]).toEqual(["sudo", "-k", "-n", "-ll", "apt-get", "update", "-qq"]);
      expect(commandCallAt(1)[0]).toEqual([
        "sudo",
        "-k",
        "-n",
        "-ll",
        "apt-get",
        "install",
        "-y",
        "golang-go",
      ]);
      assertNoAptGetFallbackCalls();
    });
  });

  it("uv not installed and no brew returns helpful error without curl auto-install", async () => {
    mockAvailableBinaries(["curl"]);

    const result = await install("py-tool");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("https://docs.astral.sh/uv/getting-started/installation/");

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("returns container-specific guidance when brew is missing in a Linux container", async () => {
    vi.mocked(isContainerEnvironment).mockReturnValue(true);
    mockAvailableBinaries([]);
    await withMockedPlatform("linux", async () => {
      skillsMocks.loadWorkspaceSkills.mockReturnValueOnce([
        makeSkillEntry(workspaceDir, "brew-tool-container", {
          kind: "brew",
          formula: "openai-whisper",
        }),
      ]);

      const result = await install("brew-tool-container");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Linux container");
      expect(result.message).toContain("Build a custom image");
      expect(result.message).toContain("openai-whisper");
      expect(result.message).not.toContain("https://brew.sh");
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  it("does not use HOMEBREW_PREFIX as a brew bin fallback for go installs", async () => {
    const maliciousPrefix = path.join(workspaceDir, "evil-brew");
    await withEnvAsync({ HOMEBREW_PREFIX: maliciousPrefix }, async () => {
      mockAvailableBinaries([]);
      vi.mocked(resolveBrewExecutable).mockReturnValue("/safe/homebrew/bin/brew");
      runCommand.mockResolvedValue(completed("ok"));
      runCommand.mockResolvedValueOnce(completed("installed go"));
      runCommand.mockResolvedValueOnce(completed("", 1, "prefix unavailable"));

      const result = await install();

      expect(result.ok).toBe(true);
      const brewInstallCall = commandCallAt(0);
      expect(brewInstallCall?.[0]).toEqual(["/safe/homebrew/bin/brew", "install", "go"]);
      expect(brewInstallCall?.[1]?.timeoutMs).toBe(300_000);
      const brewPrefixCall = commandCallAt(1);
      expect(brewPrefixCall[0]).toEqual(["/safe/homebrew/bin/brew", "--prefix"]);
      expect(brewPrefixCall[1].timeoutMs).toBe(30_000);
      const finalCall = commandCallAt(-1);
      expect(finalCall?.[0]).toEqual(["go", "install", "example.com/tool@latest"]);
      expect(finalCall?.[1]?.env?.GOBIN).not.toBe(path.join(maliciousPrefix, "bin"));
    });
  });

  describe("resolveInstallerKindReadiness", () => {
    it("skips missing-Go recipes when neither brew nor a usable apt path exists", async () => {
      await withUid(1000, async () => {
        // apt-get exists but there is no root, sudo, or brew to run it with.
        mockAvailableBinaries(["apt-get"]);

        expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: false, reason: "go" });
        expect(runCommand).not.toHaveBeenCalled();
      });
    });

    it("uses off-PATH Linuxbrew for Go but not uv bootstraps", async () => {
      mockAvailableBinaries([]);
      vi.mocked(resolveBrewExecutable).mockReturnValue("/home/linuxbrew/.linuxbrew/bin/brew");
      reply("/home/linuxbrew/.linuxbrew\n");

      expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: true });
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: false, reason: "uv" });
      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: true });
      expect(commandCallAt(0)[0]).toEqual(["/home/linuxbrew/.linuxbrew/bin/brew", "--prefix"]);
    });

    it("skips too-old Go even though the binary exists", async () => {
      mockAvailableBinaries(["go", "brew"]);
      reply("go1.18.1");

      expect(await resolveInstallerKindReadiness("go")).toEqual({ ready: false, reason: "go" });
      expectLocalGoVersionEnvCall(0);
    });

    it("mirrors uv and brew fallbacks and passes unknown kinds through", async () => {
      mockAvailableBinaries([]);
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: false, reason: "uv" });
      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: false, reason: "brew" });
      expect(await resolveInstallerKindReadiness("node")).toEqual({ ready: true });

      // On-PATH brew satisfies brew recipes and uv's brew bootstrap.
      mockAvailableBinaries(["brew"]);
      runCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      expect(await resolveInstallerKindReadiness("uv")).toEqual({ ready: true });
      expect(await resolveInstallerKindReadiness("brew")).toEqual({ ready: true });
    });
  });

  it("keeps sudo apt probes and execution noninteractive", async () => {
    await withUid(1000, async () => {
      mockAvailableBinaries(["apt-get", "sudo"]);
      mockPasswordlessSudoRule();
      mockPasswordlessSudoRule();
      reply();
      reply("golang-go:\n  Installed: (none)\n  Candidate: 2:1.22.1-1ubuntu1\n");
      reply();
      reply();

      const result = await install();

      expect(result.ok).toBe(true);
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
        ["sudo", "-k", "-n", "-ll", "apt-get", "update", "-qq"],
        ["sudo", "-k", "-n", "-ll", "apt-get", "install", "-y", "golang-go"],
        ["sudo", "-n", "apt-get", "update", "-qq"],
        ["apt-cache", "policy", "golang-go"],
        ["sudo", "-n", "apt-get", "install", "-y", "golang-go"],
        ["go", "install", "example.com/tool@latest"],
      ]);
    });
  });

  it("rejects the current old apt candidate when metadata refresh fails", async () => {
    await withUid(0, async () => {
      mockAvailableBinaries(["apt-get"]);
      reply("", 1, "temporary repository failure");
      reply("golang-go:\n  Installed: (none)\n  Candidate: 2:1.19~1\n");

      const result = await install();

      expect(result).toMatchObject({ ok: false, skipReason: "go" });
      expect(runCommand).toHaveBeenCalledTimes(2);
      const [argv, options] = commandCallAt(1);
      expect(argv).toEqual(["apt-cache", "policy", "golang-go"]);
      expect(options.env).toEqual({ LC_ALL: "C" });
    });
  });

  it("classifies a missing PATH toolchain as a deferred Go prerequisite", async () => {
    mockAvailableBinaries(["go"]);
    reply("", 1, 'go: cannot find "go1.24.0" in PATH');
    const result = await install();
    expect(result).toMatchObject({ ok: false, skipReason: "go" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(commandCallAt(0)[0]).toEqual(["go", "install", "example.com/tool@latest"]);
  });

  it("keeps ordinary Go install failures as install failures", async () => {
    process.env.PATH = "/usr/bin";
    mockAvailableBinaries(["go"]);
    reply("", 1, "go: example.com/tool@latest: module not found");

    const result = await install();

    expect(result.ok).toBe(false);
    expect(result.skipReason).toBeUndefined();
    expect(process.env.PATH).toBe("/usr/bin");
  });

  it("does not override a configured fixed toolchain for direct Go installs", async () => {
    await withEnvAsync({ GOTOOLCHAIN: "local" }, async () => {
      process.env.PATH = "/usr/bin";
      process.env.GOBIN = "/operator/go/bin";
      process.env.GOPATH = "/operator/go";
      mockAvailableBinaries(["go", "brew"]);
      reply("installed");

      const result = await install();

      expect(result.ok).toBe(true);
      expect(runCommand).toHaveBeenCalledTimes(1);
      const [argv, options] = commandCallAt(0);
      expect(argv).toEqual(["go", "install", "example.com/tool@latest"]);
      const localBin = path.join(os.homedir(), ".local", "bin");
      expect(options.env).toEqual({
        GOBIN: localBin,
        PATH: ["/usr/bin", localBin].join(path.delimiter),
      });
      expect(options.env).not.toHaveProperty("GOTOOLCHAIN");
      expect(process.env.PATH).toBe(["/usr/bin", localBin].join(path.delimiter));
      expect(process.env.GOBIN).toBe("/operator/go/bin");
      expect(process.env.GOPATH).toBe("/operator/go");
    });
  });

  it("preserves system uv/python env vars when running uv installs", async () => {
    mockAvailableBinaries(["uv"]);
    runCommand.mockResolvedValueOnce(completed("ok"));

    await withEnvAsync(
      {
        UV_PYTHON: "/tmp/attacker-python",
        UV_INDEX_URL: "https://example.invalid/simple",
        PIP_INDEX_URL: "https://example.invalid/pip",
        PYTHONPATH: "/tmp/attacker-pythonpath",
        VIRTUAL_ENV: "/tmp/attacker-venv",
      },
      async () => {
        const result = await install("py-tool", { timeoutMs: 10_000 });

        expect(result.ok).toBe(true);
        const firstCall = commandCallAt(0);
        expect(firstCall?.[0]).toEqual(["uv", "tool", "install", "example-package"]);
        expect(firstCall?.[1]?.timeoutMs).toBe(10_000);
        const envArg = firstCall?.[1]?.env;
        expect(envArg).toBeUndefined();
      },
    );
  });
});
