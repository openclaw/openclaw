import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import type { CommandOptions } from "../../process/exec.js";
import { claimManagedGitCheckout, completeManagedGitCheckout } from "./managed-checkout.js";
import { createGitCheckout } from "./shared.js";

const CANONICAL_REPO_URL = "https://github.com/openclaw/openclaw.git";
const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({ runCommandWithTimeout }));

function seedRemoteMain(dir: string): void {
  execFileSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/main", "HEAD"]);
}

async function createHostileCheckout(setup: (dir: string) => void): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-adopt-")));
  execFileSync("git", ["-C", dir, "init", "--quiet"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "OpenClaw Test"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@openclaw.invalid"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", CANONICAL_REPO_URL]);
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "openclaw" }));
  execFileSync("git", ["-C", dir, "add", "package.json"]);
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "seed hostile checkout"]);
  setup(dir);
  return dir;
}

describe("createGitCheckout", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  beforeEach(() => {
    runCommandWithTimeout.mockReset();
    runCommandWithTimeout.mockImplementation(async (argv: string[]) => {
      const destination = argv.at(-1);
      if (argv[0] === "git" && argv[1] === "clone" && destination) {
        await fs.mkdir(path.join(destination, ".git"), { recursive: true });
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
  });

  it("clones the canonical repository only when the destination does not exist", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-clone-")));
    const dir = path.join(root, "checkout");

    const result = await createGitCheckout({
      dir,
      timeoutMs: 30_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });

    expect(result?.name).toBe("git clone");
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        "git",
        "clone",
        expect.stringMatching(/^--template=.*\.openclaw-git-template-/u),
        CANONICAL_REPO_URL,
        expect.stringMatching(/checkout\.staging-/u),
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        }),
        timeoutMs: 30_000,
      }),
    );
    await expect(fs.stat(path.join(dir, ".git"))).resolves.toBeDefined();
    expect(await fs.readdir(root)).not.toContainEqual(expect.stringContaining("staging-"));
    expect(await fs.readdir(root)).not.toContainEqual(expect.stringContaining("git-template-"));
  });

  it("ignores config injection that could rewrite the canonical clone URL", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-clone-")));
    const dir = path.join(root, "checkout");

    await createGitCheckout({
      dir,
      timeoutMs: 30_000,
      env: {
        PATH: process.env.PATH,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        GIT_CONFIG_GLOBAL: "/tmp/hostile-global-config",
        GIT_TEMPLATE_DIR: "/tmp/hostile-template",
        GIT_CONFIG_PARAMETERS: "'url.https://evil.invalid/.insteadOf'='https://github.com/'",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.https://evil.invalid/.insteadOf",
        GIT_CONFIG_VALUE_0: "https://github.com/",
      },
    });

    const env = vi.mocked(runCommandWithTimeout).mock.calls[0]?.[1]?.env;
    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
    expect(env).not.toHaveProperty("GIT_TEMPLATE_DIR");
    expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(env).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
  });

  it("forces an empty template so an inherited post-checkout hook cannot execute", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-hook-")));
    const sourceDir = path.join(root, "source");
    const unsafeCloneDir = path.join(root, "unsafe-clone");
    const dir = path.join(root, "checkout");
    const templateDir = path.join(root, "hostile-template");
    const hookDir = path.join(templateDir, "hooks");
    const marker = path.join(root, "post-checkout-ran");
    const env = {
      ...process.env,
      GIT_TEMPLATE_DIR: templateDir,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };

    await fs.mkdir(sourceDir);
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "fixture.txt"), "fixture\n");
    await fs.writeFile(
      path.join(hookDir, "post-checkout"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
    );
    await fs.chmod(path.join(hookDir, "post-checkout"), 0o755);
    execFileSync("git", ["-C", sourceDir, "init", "--quiet"]);
    execFileSync("git", ["-C", sourceDir, "config", "user.name", "OpenClaw Test"]);
    execFileSync("git", ["-C", sourceDir, "config", "user.email", "test@openclaw.invalid"]);
    execFileSync("git", ["-C", sourceDir, "add", "fixture.txt"]);
    execFileSync("git", ["-C", sourceDir, "commit", "--quiet", "-m", "fixture"]);

    execFileSync("git", ["clone", "--quiet", sourceDir, unsafeCloneDir], { env });
    await expect(fs.stat(marker)).resolves.toBeDefined();
    await fs.rm(marker);

    runCommandWithTimeout.mockImplementationOnce(
      async (argv: string[], options: CommandOptions) => {
        const localArgv = argv.map((arg) => (arg === CANONICAL_REPO_URL ? sourceDir : arg));
        const [command, ...args] = localArgv;
        if (!command) {
          throw new Error("missing Git command");
        }
        execFileSync(command, args, { env: options.env });
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      },
    );

    const result = await createGitCheckout({ dir, timeoutMs: 30_000, env });

    expect(result.exitCode).toBe(0);
    await expect(fs.stat(path.join(dir, "fixture.txt"))).resolves.toBeDefined();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const cloneEnv = vi.mocked(runCommandWithTimeout).mock.calls[0]?.[1]?.env;
    expect(cloneEnv).not.toHaveProperty("GIT_TEMPLATE_DIR");
  });

  it("replaces only a checkout recorded by an earlier conversion", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-clone-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };

    await createGitCheckout({ dir, timeoutMs: 30_000, env });
    await fs.writeFile(path.join(dir, "partial-build"), "retained\n");
    await createGitCheckout({ dir, timeoutMs: 30_000, env });

    await expect(fs.stat(path.join(dir, "partial-build"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "skipFetchAll",
      setup: (dir: string) => {
        execFileSync("git", ["-C", dir, "config", "remote.origin.skipFetchAll", "true"]);
        seedRemoteMain(dir);
      },
    },
    {
      name: "a hostile fetch refspec",
      setup: (dir: string) => {
        execFileSync("git", [
          "-C",
          dir,
          "config",
          "remote.origin.fetch",
          "+refs/heads/safe:refs/remotes/origin/safe",
        ]);
        seedRemoteMain(dir);
      },
    },
    {
      name: "a pre-seeded remote-tracking ref",
      setup: seedRemoteMain,
    },
  ])("rejects a canonical-url checkout containing $name", async ({ setup }) => {
    const dir = await createHostileCheckout(setup);

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env: process.env })).rejects.toThrow(
      /creates a fresh OpenClaw checkout and will not reuse existing directories/u,
    );
    await expect(fs.stat(dir)).resolves.toBeDefined();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("removes the directory it created when launching git clone throws", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-clone-")));
    const dir = path.join(root, "checkout");
    runCommandWithTimeout.mockRejectedValueOnce(new Error("unable to launch git"));

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env: process.env })).rejects.toThrow(
      /unable to launch git/u,
    );
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects even an existing empty directory", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-empty-")));

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env: process.env })).rejects.toThrow(
      /OPENCLAW_GIT_DIR already exists/u,
    );
  });

  it("retries after an interrupted conversion left its reserved destination behind", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-crash-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    claimManagedGitCheckout(dir, env);
    await fs.mkdir(dir, { recursive: true });

    const result = await createGitCheckout({ dir, timeoutMs: 30_000, env });

    expect(result.exitCode).toBe(0);
    await expect(fs.stat(path.join(dir, ".git"))).resolves.toBeDefined();
  });

  it("refuses a destination that gained checkout state after the conversion was interrupted", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-crash-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    claimManagedGitCheckout(dir, env);
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env })).rejects.toThrow(
      /creates a fresh OpenClaw checkout and will not reuse existing directories/u,
    );
  });

  it("refuses the destination again once a completed conversion retires its ownership", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-done-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };

    await createGitCheckout({ dir, timeoutMs: 30_000, env });
    await completeManagedGitCheckout(dir, env);

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env })).rejects.toThrow(
      /creates a fresh OpenClaw checkout and will not reuse existing directories/u,
    );
  });

  it("keeps the previous checkout when replacing it fails", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-swap-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };

    await createGitCheckout({ dir, timeoutMs: 30_000, env });
    await fs.writeFile(path.join(dir, "partial-build"), "retained\n");
    runCommandWithTimeout.mockImplementationOnce(async () => {
      throw new Error("clone exploded");
    });

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env })).rejects.toThrow(
      /clone exploded/u,
    );

    await expect(fs.readFile(path.join(dir, "partial-build"), "utf8")).resolves.toBe("retained\n");
  });

  it("refuses an unrelated empty directory after a failed conversion was cleaned up", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-stale-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    runCommandWithTimeout.mockImplementationOnce(async () => {
      throw new Error("killed mid-clone");
    });

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env })).rejects.toThrow(
      /killed mid-clone/u,
    );
    await fs.mkdir(dir, { recursive: true });

    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env })).rejects.toThrow(
      /creates a fresh OpenClaw checkout and will not reuse existing directories/u,
    );
  });

  it("keeps a failed replacement retryable", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-retry-")));
    const dir = path.join(root, "checkout");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };

    await createGitCheckout({ dir, timeoutMs: 30_000, env });
    await fs.writeFile(path.join(dir, "partial-build"), "retained\n");
    runCommandWithTimeout.mockImplementationOnce(async () => {
      throw new Error("clone exploded");
    });
    await expect(createGitCheckout({ dir, timeoutMs: 30_000, env })).rejects.toThrow(
      /clone exploded/u,
    );

    const stopped = vi.fn(async () => undefined);
    const result = await createGitCheckout({
      dir,
      timeoutMs: 30_000,
      env,
      beforeReplaceManagedCheckout: stopped,
    });

    expect(result.exitCode).toBe(0);
    expect(stopped).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(dir, "partial-build"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
