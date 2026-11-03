import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGatewayHandler } from "../../gateway/server-methods/skills.test-helpers.js";
import { resolveBrewExecutable } from "../../infra/brew.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { captureEnv } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { hasBinary } from "../loading/config.js";
import { loadWorkspaceSkills, prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { readSkillResourceFiles } from "../runtime/resources.js";
import { recordSkillFileHost } from "../skill-file-host.js";
import { runCommandWithTimeoutMock as runCommand } from "../test-support/install-test-mocks.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { installSkill, installSkillDependencies } from "./install.js";

// mock-isolation: Keep package-manager commands synthetic; never invoke host installers.
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

vi.mock("../loading/plugin-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../loading/plugin-skills.js")>()),
  resolvePluginSkillRoots: () => [],
  resolvePluginAgentSkillsDirs: () => ["workshop-skills"],
}));

vi.mock("../loading/config.js", { spy: true });
vi.mock("../../infra/brew.js", { spy: true });
vi.mock("../../infra/container-environment.js", { spy: true });

// Keep the real split loader available without recursively calling its mocked export.
vi.mock("../loading/workspace-skill-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loading/workspace-skill-loader.js")>();
  return {
    ...actual,
    loadWorkspaceSkills: vi.fn(actual.loadWorkspaceSkills),
    prepareWorkspaceSkills: vi.fn(actual.prepareWorkspaceSkills),
  };
});
const originalLoadWorkspaceSkills = (() => {
  const implementation = vi.mocked(loadWorkspaceSkills).getMockImplementation();
  if (!implementation) {
    throw new Error("Skill loader mock must retain its original implementation");
  }
  return implementation;
})();

const originalPrepareWorkspaceSkills = vi.mocked(prepareWorkspaceSkills).getMockImplementation()!;

// Prefix-specific checks replace the shared mkdir spy; retain the real function to avoid recursion.
const realMkdir = fs.mkdir.bind(fs);

async function writeInstallableSkill(
  workspaceDir: string,
  name: string,
  installSpec: SkillInstallSpec | SkillInstallSpec[] = {
    id: "deps",
    kind: "node",
    package: "example-package",
  },
): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: ${JSON.stringify({ openclaw: { install: Array.isArray(installSpec) ? installSpec : [installSpec] } })}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

function loadTestWorkspaceSkillEntries(workspaceDir: string): SkillEntry[] {
  return originalLoadWorkspaceSkills(workspaceDir, { workspaceOnly: true });
}

function lastRunCommandCall(): unknown[] | undefined {
  return runCommand.mock.calls.at(-1);
}
function expectNpmInstall(packageName: string) {
  expect(lastRunCommandCall()?.[0]).toEqual([
    "npm",
    "install",
    "-g",
    "--ignore-scripts",
    packageName,
  ]);
}

function observePrivateNpmPrefix(prefix: string) {
  // Observe this prefix operation, not the shared fixture's earlier directory creation.
  return vi
    .spyOn(fs, "mkdir")
    .mockClear()
    .mockImplementation(async (target, options) => {
      // A regression must fail before it can create an operator or system directory.
      expect(target).toBe(prefix);
      expect(options).toEqual({ recursive: true, mode: 0o700 });
      return await realMkdir(target, options);
    });
}

const bridge = () => ({ readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() });
const resources = (readSkillFiles = readSkillResourceFiles) => ({
  readSkillFiles,
  readInstructions: vi.fn(),
  resolveExplicitSkill: vi.fn(),
});
function installHook(handler: Parameters<typeof addTestHook>[0]["handler"]) {
  const registry = createMockPluginRegistry([]);
  addTestHook({ registry, pluginId: "test-plugin", hookName: "before_install", handler });
  initializeGlobalHookRunner(registry);
}

const workspaceSuite = createFixtureSuite("openclaw-skills-install-");

beforeAll(async () => {
  await workspaceSuite.setup();
});

afterAll(async () => {
  resetGlobalHookRunner();
  vi.mocked(loadWorkspaceSkills).mockReset();
  vi.mocked(prepareWorkspaceSkills).mockReset();
  vi.mocked(hasBinary).mockReset();
  vi.mocked(resolveBrewExecutable).mockReset();
  vi.mocked(isContainerEnvironment).mockReset();
  // skills.status starts native watchers; close them before removing their fixture roots.
  await closeSkillsWatchers(true);
  await workspaceSuite.cleanup();
});

let workspaceDir: string;
let stateDir: string;
let homeDir: string;
let workspaceEnv: ReturnType<typeof captureEnv>;
type InstallOptions = Omit<Parameters<typeof installSkill>[0], "workspaceDir" | "skillName">;
const installTest = (skillName: string, options: Partial<InstallOptions> = {}) =>
  installSkill({ workspaceDir, skillName, installId: "deps", ...options });

beforeEach(async () => {
  workspaceDir = await workspaceSuite.createCaseDir("case");
  stateDir = path.join(workspaceDir, "state");
  homeDir = path.join(workspaceDir, "home");
  await fs.mkdir(homeDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
    if (typeof target !== "string") {
      throw new Error("Unexpected non-string mkdir fixture path");
    }
    const destination = path.resolve(target);
    // Root-hosted cases observe the system-prefix intent without writing that system directory.
    if (destination === "/var/lib/openclaw/tools/node/npm") {
      expect(process.getuid?.()).toBe(0);
      expect(options).toEqual({ recursive: true, mode: 0o700 });
      return undefined;
    }
    expect(
      destination === workspaceDir || destination.startsWith(`${workspaceDir}${path.sep}`),
    ).toBe(true);
    return await realMkdir(target, options);
  });
  workspaceEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
  process.env.OPENCLAW_STATE_DIR = stateDir;
});
afterEach(async () => {
  try {
    await closeSkillsWatchers(true);
  } finally {
    vi.restoreAllMocks();
    workspaceEnv.restore();
  }
});

describe("installSkill before_install hooks", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    runCommand.mockClear();
    vi.mocked(loadWorkspaceSkills).mockReset().mockImplementation(loadTestWorkspaceSkillEntries);
    vi.mocked(prepareWorkspaceSkills)
      .mockReset()
      .mockImplementation(async (dir, options) => loadWorkspaceSkills(dir, options));
    vi.mocked(hasBinary).mockReset();
    vi.mocked(resolveBrewExecutable).mockReset();
    vi.mocked(isContainerEnvironment).mockReset();
    runCommand.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
  });

  it("installs the current host recipe for a hidden skill through the Gateway", async () => {
    const { skillsHandlers } = await import("../../gateway/server-methods/skills.js");
    vi.spyOn(os, "tmpdir").mockReturnValue(workspaceDir);
    const hostDir = path.join(workspaceDir, "host");
    await fs.mkdir(hostDir, { recursive: true });
    vi.mocked(prepareWorkspaceSkills).mockImplementation(originalPrepareWorkspaceSkills);
    const skillName = "host-dependency";
    for (const [dir, packageName] of [
      [workspaceDir, "stale-gateway-package"],
      [hostDir, "current-host-package"],
    ] as const) {
      await writeInstallableSkill(dir, skillName, {
        id: "deps",
        kind: "node",
        package: packageName,
      });
    }
    const hostInstall = vi.fn(async (request: Parameters<typeof installSkillDependencies>[0]) => {
      const homedir = vi.spyOn(os, "homedir").mockReturnValue(hostDir);
      const uid = process.getuid ? vi.spyOn(process, "getuid").mockReturnValue(501) : undefined;
      try {
        return await installSkillDependencies(request);
      } finally {
        uid?.mockRestore();
        homedir.mockRestore();
      }
    });
    const release = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: bridge(),
      installSkillDependencies: hostInstall,
      skillResources: resources(),
      loadSkills: async (request) =>
        readWorkspaceSkillSources({
          ...request,
          sourcePlan: resolveWorkspaceSkillSourcePlan(hostDir, { workspaceOnly: true }),
        }),
    });
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        ownership: "explicit",
        entries: { ops: { workspace: workspaceDir, skills: [] } },
      },
    };
    try {
      const result = await callGatewayHandler(
        skillsHandlers,
        "skills.install",
        { agentId: "ops", name: skillName, installId: "deps" },
        { context: { getRuntimeConfig: () => config } },
      );
      expect(result.ok).toBe(true);
      expect(hostInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({ package: "current-host-package" }),
        }),
      );
      await expect(fs.stat(path.join(stateDir, "tools"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expectNpmInstall("current-host-package");
      expect(lastRunCommandCall()?.[1]).toMatchObject({
        env: { NPM_CONFIG_PREFIX: path.join(hostDir, ".openclaw", "tools", "node", "npm") },
      });
    } finally {
      release();
    }
  });

  it.each(["deny", "host-failure", "missing-installer"] as const)(
    "keeps remote dependency installs behind Gateway policy without local fallback (%s)",
    async (outcome) => {
      vi.spyOn(os, "tmpdir").mockReturnValue(workspaceDir);
      const hostDir = path.join(workspaceDir, "policy-host");
      await fs.mkdir(hostDir, { recursive: true });
      await writeInstallableSkill(hostDir, "policy-host");
      vi.mocked(prepareWorkspaceSkills).mockImplementation(originalPrepareWorkspaceSkills);
      let inspectedPath: string | undefined;
      const policy = vi.fn(async (event: { sourcePath: string }) => {
        inspectedPath = event.sourcePath;
        expect(inspectedPath).not.toContain(hostDir);
        expect(await fs.readFile(path.join(inspectedPath, "runner.js"), "utf8")).toBe(
          "export {};\n",
        );
        return outcome === "deny" ? { block: true, blockReason: "Organization denied" } : undefined;
      });
      installHook(policy);
      const hostInstall = vi.fn(async () => {
        throw new Error("Harness connection lost");
      });
      const release = registerAgentWorkspaceAccess(workspaceDir, {
        bridge: bridge(),
        ...(outcome === "missing-installer" ? {} : { installSkillDependencies: hostInstall }),
        skillResources: resources(),
        loadSkills: async (request) =>
          readWorkspaceSkillSources({
            ...request,
            sourcePlan: resolveWorkspaceSkillSourcePlan(hostDir, { workspaceOnly: true }),
          }),
      });
      try {
        const install = installTest("policy-host");
        if (outcome === "deny") {
          expect(await install).toMatchObject({
            ok: false,
            message: expect.stringContaining("Organization denied"),
          });
          expect(hostInstall).not.toHaveBeenCalled();
        } else {
          await expect(install).rejects.toThrow(
            outcome === "host-failure"
              ? "Harness connection lost"
              : "Remote skill dependency installation is unavailable",
          );
        }
        expect(runCommand).not.toHaveBeenCalled();
        if (outcome !== "missing-installer") {
          expect(policy).toHaveBeenCalledOnce();
          await expect(fs.stat(inspectedPath!)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        release();
      }
    },
  );

  it("checks Gateway-owned skill files locally but installs their dependencies on the Harness", async () => {
    await writeInstallableSkill(workspaceDir, "gateway-owned");
    const entries = loadTestWorkspaceSkillEntries(workspaceDir);
    recordSkillFileHost(entries[0]!.skill, "gateway");
    vi.mocked(prepareWorkspaceSkills).mockResolvedValue(entries);
    const hostInstall = vi.fn(async () => ({
      ok: true,
      message: "Installed",
      stdout: "",
      stderr: "",
      code: 0,
    }));
    const readRemote = vi.fn();
    const policy = vi.fn(async (event: { sourcePath: string }) => {
      expect(event.sourcePath).toBe(entries[0]!.skill.baseDir);
      expect(await fs.readFile(path.join(event.sourcePath, "runner.js"), "utf8")).toBe(
        "export {};\n",
      );
    });
    installHook(policy);
    const release = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: bridge(),
      loadSkills: vi.fn(),
      installSkillDependencies: hostInstall,
      skillResources: resources(readRemote),
    });
    try {
      expect(await installTest("gateway-owned")).toMatchObject({ ok: true });
      expect(policy).toHaveBeenCalledOnce();
      expect(hostInstall).toHaveBeenCalledOnce();
      expect(readRemote).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it.each([
    {
      platform: "darwin" as const,
      guidance: "Homebrew is not installed. Install it from https://brew.sh",
    },
    {
      platform: "linux" as const,
      guidance:
        'Homebrew is not installed. Install it from https://brew.sh or install "vendor/tap/tool" manually using your system package manager (e.g. apt, dnf, pacman).',
    },
  ])("preserves supported-platform missing-brew guidance on $platform", async (testCase) => {
    await writeInstallableSkill(workspaceDir, "brew-tool", {
      id: "brew",
      kind: "brew",
      formula: "vendor/tap/tool",
    });
    vi.mocked(hasBinary).mockReturnValue(false);
    vi.mocked(resolveBrewExecutable).mockReturnValue(undefined);
    vi.mocked(isContainerEnvironment).mockReturnValue(false);
    const result = await withMockedPlatform(testCase.platform, () =>
      installTest("brew-tool", { installId: "brew" }),
    );

    expect(result).toMatchObject({
      ok: false,
      message: `brew not installed — ${testCase.guidance}`,
      code: null,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reports FreeBSD manual recovery over RPC without running an installer", async () => {
    const { skillsHandlers } = await import("../../gateway/server-methods/skills.js");
    const skillName = "brew-manual-recovery";
    await writeInstallableSkill(workspaceDir, skillName, {
      id: "brew",
      kind: "brew",
      formula: "vendor/tap/tool",
    });
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: { workspace: workspaceDir } } },
    };
    vi.mocked(hasBinary).mockReturnValue(false);
    vi.mocked(resolveBrewExecutable).mockReturnValue(undefined);
    await withMockedPlatform("freebsd", async () => {
      const result = await callGatewayHandler(
        skillsHandlers,
        "skills.install",
        { agentId: "ops", name: skillName, installId: "brew" },
        { context: { getRuntimeConfig: () => config } },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Homebrew is not supported on FreeBSD"),
      });
      expect(result.response).toMatchObject({
        ok: false,
        message: expect.stringContaining("pkg or Ports"),
        code: null,
      });
      const message = (result.error as { message: string }).message;
      expect(message).toContain("Gateway host");
      expect(message).toContain("openclaw skills check");
      expect(message).toContain("--agent <id>");
      expect(message).not.toContain("brew.sh");
      expect(message).not.toContain("vendor/tap/tool");
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  it("installs the advertised Workshop recipe for each agent sharing a workspace", async () => {
    const { skillsHandlers } = await import("../../gateway/server-methods/skills.js");
    vi.mocked(loadWorkspaceSkills).mockImplementation(originalLoadWorkspaceSkills);
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: { workspace: workspaceDir, skills: [] },
          research: { workspace: workspaceDir },
        },
      },
    };
    const skillName = "shared-workshop-recipe";
    for (const agentId of ["ops", "research"]) {
      const skillDir = await writeInstallableSkill(workspaceDir, skillName, {
        id: "deps",
        kind: "node",
        package: `${agentId}-package`,
      });
      const workshopDir = resolveWorkshopSkillsDir(config, agentId);
      await fs.mkdir(workshopDir, { recursive: true });
      await fs.rename(skillDir, path.join(workshopDir, skillName));
    }

    for (const agentId of ["research", "ops"]) {
      const context = { getRuntimeConfig: () => config };
      const status = await callGatewayHandler(
        skillsHandlers,
        "skills.status",
        { agentId },
        {
          context,
        },
      );
      expect(status.ok).toBe(true);
      expect(status.response).toMatchObject({
        skills: expect.arrayContaining([
          expect.objectContaining({
            name: skillName,
            source: "openclaw-workshop",
            install: expect.arrayContaining([expect.objectContaining({ id: "deps" })]),
          }),
        ]),
      });

      runCommand.mockClear();
      const result = await callGatewayHandler(
        skillsHandlers,
        "skills.install",
        { agentId, name: skillName, installId: "deps" },
        { context },
      );

      expect(result.error).toBeUndefined();
      expect(result.response).toMatchObject({ ok: true, message: "Installed", code: 0 });
      expect(runCommand).toHaveBeenCalledTimes(1);
      expectNpmInstall(`${agentId}-package`);
    }
  });

  it("installs advertised download recipes after OS filtering with generated IDs", async () => {
    const handler = vi.fn().mockReturnValue({ block: true, blockReason: "Recipe observed" });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const foreignOs = process.platform === "darwin" ? "linux" : "darwin";
    const specs = [foreignOs, process.platform, undefined].map((installOs, index) => {
      const spec: SkillInstallSpec = {
        kind: "download",
        url: `https://example.invalid/recipe-${index}.tar.gz`,
      };
      if (installOs) {
        spec.os = [installOs];
      }
      return spec;
    });
    await writeInstallableSkill(workspaceDir, "platform-recipes", specs);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      entries: loadTestWorkspaceSkillEntries(workspaceDir),
    });
    const options = report.skills[0]!.install;
    expect(options).toHaveLength(2);

    for (const [index, option] of options.entries()) {
      const sourceIndex = index + 1;
      const result = await installTest("platform-recipes", { installId: option.id });

      expect(result.message).toBe("Recipe observed");
      expect(handler.mock.calls.at(-1)?.[0]).toMatchObject({
        skill: { installSpec: specs[sourceIndex] },
      });
      expect(option.id).toBe(`download-${sourceIndex}`);
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("keeps the default npm prefix out of env-overridden state paths", async () => {
    await writeInstallableSkill(workspaceDir, "env-prefix-skill");
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    const prefix = path.join(homeDir, ".openclaw", "tools", "node", "npm");
    const mkdirSpy = observePrivateNpmPrefix(prefix);
    const uidSpy = process.getuid ? vi.spyOn(process, "getuid").mockReturnValue(501) : undefined;
    try {
      process.env.OPENCLAW_STATE_DIR = "/tmp/untrusted-state";
      process.env.OPENCLAW_CONFIG_PATH = "/tmp/untrusted-config/openclaw.json";
      const result = await withMockedPlatform("darwin", () =>
        installTest("env-prefix-skill", { config: {} }),
      );
      expect(result.ok).toBe(true);
      expect(mkdirSpy).toHaveBeenCalledExactlyOnceWith(prefix, { recursive: true, mode: 0o700 });
      expectNpmInstall("example-package");
      expect(lastRunCommandCall()?.[1]).toMatchObject({
        env: { NPM_CONFIG_PREFIX: prefix, npm_config_prefix: prefix },
      });
      expect(lastRunCommandCall()?.[1]).not.toHaveProperty("env.PATH");
      expect(await fs.stat(prefix).then((stat) => stat.isDirectory())).toBe(true);
    } finally {
      uidSpy?.mockRestore();
      mkdirSpy.mockRestore();
      envSnapshot.restore();
    }
  });

  it("uses a fixed system state root for root npm installs", async () => {
    await writeInstallableSkill(workspaceDir, "root-prefix-skill");
    const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/openclaw");
    const prefix = "/var/lib/openclaw/tools/node/npm";
    // Observe the real consumer's system-prefix intent without writing that system path.
    const mkdirSpy = vi.mocked(fs.mkdir).mockClear();
    try {
      Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
      const result = await withMockedPlatform("linux", () =>
        installTest("root-prefix-skill", { config: {} }),
      );
      expect(result.ok).toBe(true);
      expect(mkdirSpy).toHaveBeenCalledExactlyOnceWith(prefix, { recursive: true, mode: 0o700 });
      expect(runCommand).toHaveBeenCalledTimes(1);
      expectNpmInstall("example-package");
      expect(lastRunCommandCall()?.[1]).toMatchObject({
        env: { NPM_CONFIG_PREFIX: prefix, npm_config_prefix: prefix },
      });
    } finally {
      mkdirSpy.mockRestore();
      cwdSpy.mockRestore();
      if (uidDescriptor) {
        Object.defineProperty(process, "getuid", uidDescriptor);
      } else {
        Reflect.deleteProperty(process, "getuid");
      }
    }
  });

  it("blocks install when before_install rejects the skill", async () => {
    const sha256 = "A1B2C3D4".repeat(8);
    const handler = vi.fn().mockReturnValue({
      block: true,
      blockReason: "Blocked by plugin lifecycle hook",
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    await writeInstallableSkill(workspaceDir, "blocked-skill", {
      id: "deps",
      kind: "download",
      url: "https://example.com/runtime.tar.gz",
      sha256: ` ${sha256} `,
    });

    const result = await installTest("blocked-skill");

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Blocked by plugin lifecycle hook");
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      skill: {
        installId: "deps",
        installSpec: {
          kind: "download",
          url: "https://example.com/runtime.tar.gz",
          sha256: sha256.toLowerCase(),
        },
      },
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
