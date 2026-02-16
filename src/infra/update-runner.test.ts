import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pathExists } from "../utils.js";
import { runGatewayUpdate } from "./update-runner.js";

type CommandResult = { stdout?: string; stderr?: string; code?: number };

function createRunner(responses: Record<string, CommandResult>) {
  const calls: string[] = [];
  const runner = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    const res = responses[key] ?? {};
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      code: res.code ?? 0,
    };
  };
  return { runner, calls };
}

describe("runGatewayUpdate", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let tempDir: string;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    tempDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, "openclaw.mjs"), "export {};\n", "utf-8");
  });

  afterEach(async () => {
    // Shared fixtureRoot cleaned up in afterAll.
  });

  function createStableTagRunner(params: {
    stableTag: string;
    uiIndexPath: string;
    onDoctor?: () => Promise<void>;
    onUiBuild?: (count: number) => Promise<void>;
  }) {
    const calls: string[] = [];
    let uiBuildCount = 0;
    const doctorKey = `${process.execPath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`;

    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { stdout: `${params.stableTag}\n`, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach ${params.stableTag}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        uiBuildCount += 1;
        await params.onUiBuild?.(uiBuildCount);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorKey) {
        await params.onDoctor?.();
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    return {
      runCommand,
      calls,
      doctorKey,
      getUiBuildCount: () => uiBuildCount,
    };
  }

  async function setupGitCheckout(options?: { packageManager?: string }) {
    await fs.mkdir(path.join(tempDir, ".git"));
    const pkg: Record<string, string> = { name: "openclaw", version: "1.0.0" };
    if (options?.packageManager) {
      pkg.packageManager = options.packageManager;
    }
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify(pkg), "utf-8");
  }

  async function setupUiIndex() {
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>", "utf-8");
    return uiIndexPath;
  }

  async function removeControlUiAssets() {
    await fs.rm(path.join(tempDir, "dist", "control-ui"), { recursive: true, force: true });
  }

  it("skips git update when worktree is dirty", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: " M README.md" },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dirty");
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it("aborts rebase on failure", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: "upstream123" },
      [`git -C ${tempDir} rev-list --max-count=10 upstream123`]: { stdout: "upstream123\n" },
      [`git -C ${tempDir} rebase upstream123`]: { code: 1, stderr: "conflict" },
      [`git -C ${tempDir} rebase --abort`]: { stdout: "" },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("rebase-failed");
    expect(calls.some((call) => call.includes("rebase --abort"))).toBe(true);
  });

  it("uses stable tag when beta tag is older than release", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    const betaTag = "v1.0.0-beta.2";
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: {
        stdout: `${stableTag}\n${betaTag}\n`,
      },
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`${process.execPath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`]: {
        stdout: "",
      },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
      channel: "beta",
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${betaTag}`);
  });

  it("skips update when no git root", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "openclaw", packageManager: "pnpm@8.0.0" }),
      "utf-8",
    );
    await fs.writeFile(path.join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { code: 1 },
      "npm root -g": { code: 1 },
      "pnpm root -g": { code: 1 },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not-git-install");
    expect(calls.some((call) => call.startsWith("pnpm add -g"))).toBe(false);
    expect(calls.some((call) => call.startsWith("npm i -g"))).toBe(false);
  });

  async function runNpmGlobalUpdateCase(params: {
    expectedInstallCommand: string;
    channel?: "stable" | "beta";
    tag?: string;
  }): Promise<{ calls: string[]; result: Awaited<ReturnType<typeof runGatewayUpdate>> }> {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      "utf-8",
    );

    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: params.expectedInstallCommand,
      onInstall: async () => {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          "utf-8",
        );
      },
    });

    const result = await runGatewayUpdate({
      cwd: pkgRoot,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
      channel: params.channel,
      tag: params.tag,
    });

    return { calls, result };
  }

  const createGlobalInstallHarness = (params: {
    pkgRoot: string;
    npmRootOutput?: string;
    installCommand: string;
    onInstall?: () => Promise<void>;
  }) => {
    const calls: string[] = [];
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      if (key === `git -C ${params.pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        if (params.npmRootOutput) {
          return { stdout: params.npmRootOutput, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === params.installCommand) {
        await params.onInstall?.();
        return { stdout: "ok", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    return { calls, runCommand };
  };

  it.each([
    {
      title: "updates global npm installs when detected",
      expectedInstallCommand: "npm i -g openclaw@latest",
    },
    {
      title: "uses update channel for global npm installs when tag is omitted",
      expectedInstallCommand: "npm i -g openclaw@beta",
      channel: "beta" as const,
    },
    {
      title: "updates global npm installs with tag override",
      expectedInstallCommand: "npm i -g openclaw@beta",
      tag: "beta",
    },
  ])("$title", async ({ expectedInstallCommand, channel, tag }) => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand,
      channel,
      tag,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.before?.version).toBe("1.0.0");
    expect(result.after?.version).toBe("2.0.0");
    expect(calls.some((call) => call === expectedInstallCommand)).toBe(true);
  });

  it("cleans stale npm rename dirs before global update", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const staleDir = path.join(nodeModules, ".openclaw-stale");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      "utf-8",
    );

    let stalePresentAtInstall = true;
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      if (key === `git -C ${pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        return { stdout: nodeModules, stderr: "", code: 0 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "npm i -g openclaw@latest") {
        stalePresentAtInstall = await pathExists(staleDir);
        return { stdout: "ok", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runGatewayUpdate({
      cwd: pkgRoot,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("ok");
    expect(stalePresentAtInstall).toBe(false);
    expect(await pathExists(staleDir)).toBe(false);
  });

  it("updates global bun installs when detected", async () => {
    const oldBunInstall = process.env.BUN_INSTALL;
    const bunInstall = path.join(tempDir, "bun-install");
    process.env.BUN_INSTALL = bunInstall;

    try {
      const bunGlobalRoot = path.join(bunInstall, "install", "global", "node_modules");
      const pkgRoot = path.join(bunGlobalRoot, "openclaw");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.writeFile(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0" }),
        "utf-8",
      );

      const { calls, runCommand } = createGlobalInstallHarness({
        pkgRoot,
        installCommand: "bun add -g openclaw@latest",
        onInstall: async () => {
          await fs.writeFile(
            path.join(pkgRoot, "package.json"),
            JSON.stringify({ name: "openclaw", version: "2.0.0" }),
            "utf-8",
          );
        },
      });

      const result = await runGatewayUpdate({
        cwd: pkgRoot,
        runCommand: async (argv, _options) => runCommand(argv),
        timeoutMs: 5000,
      });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("bun");
      expect(result.before?.version).toBe("1.0.0");
      expect(result.after?.version).toBe("2.0.0");
      expect(calls.some((call) => call === "bun add -g openclaw@latest")).toBe(true);
    } finally {
      if (oldBunInstall === undefined) {
        delete process.env.BUN_INSTALL;
      } else {
        process.env.BUN_INSTALL = oldBunInstall;
      }
    }
  });

  it("rejects git roots that are not a openclaw checkout", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
    });

    cwdSpy.mockRestore();

    expect(result.status).toBe("error");
    expect(result.reason).toBe("not-openclaw-root");
    expect(calls.some((call) => call.includes("status --porcelain"))).toBe(false);
  });

  it("fails with a clear reason when openclaw.mjs is missing", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await fs.rm(path.join(tempDir, "openclaw.mjs"), { force: true });

    const stableTag = "v1.0.1-1";
    const { runner } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: { stdout: `${stableTag}\n` },
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runner(argv),
      timeoutMs: 5000,
      channel: "stable",
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("doctor-entry-missing");
    expect(result.steps.at(-1)?.name).toBe("openclaw doctor entry");
  });

  it("repairs UI assets when doctor run removes control-ui files", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand, calls, doctorKey, getUiBuildCount } = createStableTagRunner({
      stableTag,
      uiIndexPath,
      onUiBuild: async (count) => {
        await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
        await fs.writeFile(uiIndexPath, `<html>${count}</html>`, "utf-8");
      },
      onDoctor: removeControlUiAssets,
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
      channel: "stable",
    });

    expect(result.status).toBe("ok");
    expect(getUiBuildCount()).toBe(2);
    expect(await pathExists(uiIndexPath)).toBe(true);
    expect(calls).toContain(doctorKey);
  });

  it("fails when UI assets are still missing after post-doctor repair", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand } = createStableTagRunner({
      stableTag,
      uiIndexPath,
      onUiBuild: async (count) => {
        if (count === 1) {
          await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
          await fs.writeFile(uiIndexPath, "<html>built</html>", "utf-8");
        }
      },
      onDoctor: removeControlUiAssets,
    });

    const result = await runGatewayUpdate({
      cwd: tempDir,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
      channel: "stable",
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("ui-assets-missing");
  });
});
