import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";

const resolveBundledInstallPlanForCatalogEntry = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../cli/plugin-install-plan.js", () => ({
  resolveBundledInstallPlanForCatalogEntry,
}));

const resolveBundledPluginSources = vi.hoisted(() => vi.fn(() => new Map()));
const findBundledPluginSourceInMap = vi.hoisted(() => vi.fn(() => null));
vi.mock("../plugins/bundled-sources.js", () => ({
  resolveBundledPluginSources,
  findBundledPluginSourceInMap,
}));

const installPluginFromNpmSpec = vi.hoisted(() => vi.fn());
vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec,
}));

const enablePluginInConfig = vi.hoisted(() => vi.fn((cfg) => ({ config: cfg, enabled: true })));
vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig,
}));

const recordPluginInstall = vi.hoisted(() => vi.fn((cfg) => cfg));
const buildNpmResolutionInstallFields = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall,
  buildNpmResolutionInstallFields,
}));

const resolveGitHeadPath = vi.hoisted(() => vi.fn<(root: string) => string | null>(() => null));
vi.mock("../infra/git-root.js", () => ({
  resolveGitHeadPath,
}));

import { ensureOnboardingPluginInstalled } from "./onboarding-plugin-install.js";

describe("ensureOnboardingPluginInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveGitHeadPath.mockReturnValue(null);
  });

  it("passes pinned npm specs and expected integrity to npm installs", async () => {
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "demo-plugin",
      targetDir: "/tmp/demo-plugin",
      version: "1.2.3",
      npmResolution: {
        resolvedSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
        integrity: "sha512-wecom",
      },
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "WeCom",
        install: {
          npmSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
          expectedIntegrity: "sha512-wecom",
        },
      },
      prompter: {
        select: vi.fn(async () => "npm"),
      } as never,
      runtime: {} as never,
    });

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@wecom/wecom-openclaw-plugin@1.2.3",
        expectedIntegrity: "sha512-wecom",
      }),
    );
    expect(result.installed).toBe(true);
  });

  it("does not offer local installs when the workspace only has a spoofed .git marker", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-spoofed-git-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, ".git"), "not-a-gitdir-pointer\n", "utf8");

      let captured:
        | {
            message: string;
            options: Array<{ value: "npm" | "local" | "skip"; label: string; hint?: string }>;
            initialValue: "npm" | "local" | "skip";
          }
        | undefined;

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      expect(captured).toBeDefined();
      expect(captured?.message).toBe("Install Demo Plugin plugin?");
      expect(captured?.options).toEqual([{ value: "skip", label: "Skip for now" }]);
      expect(result).toEqual({
        cfg: {},
        installed: false,
        pluginId: "demo-plugin",
      });
    });
  });

  it("allows local installs for real gitdir checkouts and sanitizes prompt text", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-gitdir-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      const gitDir = path.join(workspaceDir, ".actual-git");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(path.join(gitDir, "objects"), { recursive: true });
      await fs.mkdir(path.join(gitDir, "refs"), { recursive: true });
      await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, ".git"), "gitdir: .actual-git\n", "utf8");
      resolveGitHeadPath.mockImplementation((root: string) =>
        root === workspaceDir ? path.join(gitDir, "HEAD") : null,
      );

      let captured:
        | {
            message: string;
            options: Array<{ value: "npm" | "local" | "skip"; label: string; hint?: string }>;
            initialValue: "npm" | "local" | "skip";
          }
        | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo\x1b[31m Plugin\n",
          install: {
            npmSpec: "@demo/\x1b[32mplugin",
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      expect(captured).toBeDefined();
      expect(captured?.message).toBe("Install Demo Plugin\\n plugin?");
      expect(captured?.options).toEqual([
        { value: "npm", label: "Download from npm (@demo/plugin)" },
        {
          value: "local",
          label: "Use local plugin path",
          hint: path.join(workspaceDir, "plugins", "demo"),
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(captured?.message).not.toContain("\x1b");
      expect(captured?.options[0]?.label).not.toContain("\x1b");
    });
  });

  it("allows local installs for linked git worktrees", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-worktree-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      const commonGitDir = path.join(temp, "repo.git");
      const worktreeGitDir = path.join(commonGitDir, "worktrees", "workspace");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(path.join(commonGitDir, "objects"), { recursive: true });
      await fs.mkdir(path.join(commonGitDir, "refs"), { recursive: true });
      await fs.mkdir(worktreeGitDir, { recursive: true });
      await fs.writeFile(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
      await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
      resolveGitHeadPath.mockImplementation((root: string) =>
        root === workspaceDir ? path.join(worktreeGitDir, "HEAD") : null,
      );

      let captured:
        | {
            message: string;
            options: Array<{ value: "npm" | "local" | "skip"; label: string; hint?: string }>;
            initialValue: "npm" | "local" | "skip";
          }
        | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: path.join(workspaceDir, "plugins", "demo"),
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(captured?.initialValue).toBe("local");
    });
  });

  it("keeps local installs available when cwd is a git repo but workspaceDir is not", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-cwd-git-" }, async (temp) => {
      const repoDir = path.join(temp, "repo");
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(temp, "demo-plugin");
      await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
      await fs.mkdir(path.join(repoDir, ".git", "objects"), { recursive: true });
      await fs.mkdir(path.join(repoDir, ".git", "refs"), { recursive: true });
      await fs.writeFile(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      resolveGitHeadPath.mockImplementation((root: string) =>
        root === process.cwd() ? path.join(repoDir, ".git", "HEAD") : null,
      );

      let captured:
        | {
            options: Array<{ value: "npm" | "local" | "skip"; label: string; hint?: string }>;
          }
        | undefined;
      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: pluginDir,
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: pluginDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
    });
  });
});
