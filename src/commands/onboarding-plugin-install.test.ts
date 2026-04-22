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

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFileSync,
}));

const withTimeout = vi.hoisted(() => vi.fn(async <T>(promise: Promise<T>) => await promise));
vi.mock("../utils/with-timeout.js", () => ({
  withTimeout,
}));

import { ensureOnboardingPluginInstalled } from "./onboarding-plugin-install.js";

describe("ensureOnboardingPluginInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileSync.mockImplementation(() => {
      throw new Error("not a git worktree");
    });
    withTimeout.mockImplementation(async <T>(promise: Promise<T>) => await promise);
  });

  it("passes pinned npm specs and expected integrity to npm installs with progress", async () => {
    installPluginFromNpmSpec.mockImplementation(async (params) => {
      params.logger?.info?.("Downloading demo-plugin…");
      return {
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: "1.2.3",
        npmResolution: {
          resolvedSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
          integrity: "sha512-wecom",
        },
      };
    });
    const stop = vi.fn();
    const update = vi.fn();

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
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: {} as never,
    });

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@wecom/wecom-openclaw-plugin@1.2.3",
        expectedIntegrity: "sha512-wecom",
        timeoutMs: 300_000,
      }),
    );
    expect(update).toHaveBeenCalledWith("Downloading demo-plugin…");
    expect(stop).toHaveBeenCalledWith("Installed WeCom plugin");
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
  });

  it("returns a timed out status and notes the retry path when npm install hangs", async () => {
    const note = vi.fn(async () => {});
    const stop = vi.fn();
    withTimeout.mockRejectedValue(new Error("timeout"));

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          npmSpec: "@demo/plugin",
        },
      },
      prompter: {
        select: vi.fn(async () => "npm"),
        note,
        progress: vi.fn(() => ({ update: vi.fn(), stop })),
      } as never,
      runtime: {
        error: vi.fn(),
      } as never,
    });

    expect(result).toEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "timed_out",
    });
    expect(stop).toHaveBeenCalledWith("Install timed out: Demo Plugin");
    expect(note).toHaveBeenCalledWith(
      "Installing @demo/plugin timed out after 5 minutes.\nReturning to selection.",
      "Plugin install",
    );
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
        status: "skipped",
      });
    });
  });

  it("allows local installs for real gitdir checkouts and sanitizes prompt text", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-gitdir-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      const realWorkspaceDir = await fs.realpath(workspaceDir);
      execFileSync.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("git");
        if (args[1] !== realWorkspaceDir || args[2] !== "rev-parse") {
          throw new Error("unexpected git call");
        }
        const request = args.slice(3).join(" ");
        if (request === "--is-inside-work-tree") {
          return "true\n";
        }
        if (request === "--path-format=absolute --show-toplevel") {
          return `${realWorkspaceDir}\n`;
        }
        if (request === "--path-format=absolute --git-common-dir") {
          return `${path.join(realWorkspaceDir, ".git")}\n`;
        }
        throw new Error(`unexpected git args: ${request}`);
      });

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

      const realPluginDir = await fs.realpath(pluginDir);
      expect(captured).toBeDefined();
      expect(captured?.message).toBe("Install Demo Plugin\\n plugin?");
      expect(captured?.options).toEqual([
        { value: "npm", label: "Download from npm (@demo/plugin)" },
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
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
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(commonGitDir, { recursive: true });
      const realWorkspaceDir = await fs.realpath(workspaceDir);
      const realCommonGitDir = await fs.realpath(commonGitDir);
      execFileSync.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("git");
        if (args[1] !== realWorkspaceDir || args[2] !== "rev-parse") {
          throw new Error("unexpected git call");
        }
        const request = args.slice(3).join(" ");
        if (request === "--is-inside-work-tree") {
          return "true\n";
        }
        if (request === "--path-format=absolute --show-toplevel") {
          return `${realWorkspaceDir}\n`;
        }
        if (request === "--path-format=absolute --git-common-dir") {
          return `${realCommonGitDir}\n`;
        }
        throw new Error(`unexpected git args: ${request}`);
      });

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

      const realPluginDir = await fs.realpath(pluginDir);
      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
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
      const pluginDir = path.join(repoDir, "demo-plugin");
      await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      const realRepoDir = await fs.realpath(repoDir);
      execFileSync.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("git");
        const root = args[1];
        if (args[2] !== "rev-parse") {
          throw new Error("unexpected git call");
        }
        const request = args.slice(3).join(" ");
        if (root !== realRepoDir) {
          throw new Error("not a git worktree");
        }
        if (request === "--is-inside-work-tree") {
          return "true\n";
        }
        if (request === "--path-format=absolute --show-toplevel") {
          return `${realRepoDir}\n`;
        }
        if (request === "--path-format=absolute --git-common-dir") {
          return `${path.join(realRepoDir, ".git")}\n`;
        }
        throw new Error(`unexpected git args: ${request}`);
      });

      let captured:
        | {
            options: Array<{ value: "npm" | "local" | "skip"; label: string; hint?: string }>;
          }
        | undefined;
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoDir);
      try {
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
      } finally {
        cwdSpy.mockRestore();
      }

      const realPluginDir = await fs.realpath(pluginDir);
      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
    });
  });

  it("rejects local install paths outside the trusted workspace roots", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-outside-root-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(temp, "external-plugin");
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });
      const realWorkspaceDir = await fs.realpath(workspaceDir);
      execFileSync.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("git");
        if (args[1] !== realWorkspaceDir || args[2] !== "rev-parse") {
          throw new Error("unexpected git call");
        }
        const request = args.slice(3).join(" ");
        if (request === "--is-inside-work-tree") {
          return "true\n";
        }
        if (request === "--path-format=absolute --show-toplevel") {
          return `${realWorkspaceDir}\n`;
        }
        if (request === "--path-format=absolute --git-common-dir") {
          return `${path.join(realWorkspaceDir, ".git")}\n`;
        }
        throw new Error(`unexpected git args: ${request}`);
      });

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

      expect(captured?.options).toEqual([{ value: "skip", label: "Skip for now" }]);
    });
  });
});
