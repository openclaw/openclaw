import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as checkoutConfig from "../../agents/worktrees/checkout-git-config.js";
import * as worktreeGit from "../../agents/worktrees/git.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { prepareLocalWorkspaceCheckout } from "./local-workspace-checkout.js";
import * as inventory from "./workspace-sync-inventory.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refreshes independent checkouts without replacing unchanged files or dependencies", async ({
  signal,
}) => {
  const root = dirs.make("local-checkout-refresh-");
  const source = path.join(root, "source");
  const destination = path.join(root, "workspace");
  await fs.mkdir(source);
  const git = (...args: string[]) => worktreeGit.requireGit(source, args);
  await git("init", "--quiet", "--template=", "-b", "main");
  await git("config", "user.name", "Checkout Test");
  await git("config", "user.email", "checkout@example.invalid");
  for (const name of ["unchanged", "removed", "changed"]) {
    await fs.writeFile(path.join(source, name), `${name}\n`);
  }
  const shared = "shared source line\n".repeat(2_000);
  await fs.writeFile(path.join(source, "versioned"), `${shared}original\n`);
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "base");
  const baseCommit = await git("rev-parse", "HEAD");
  const deletedBlob = await git("rev-parse", "HEAD:removed");
  const priorBlob = await git("rev-parse", "HEAD:versioned");
  const checkout = {
    source,
    destination,
    temporaryRoot: root,
    baseCommit,
    branch: "template",
    signal,
    assertCurrent: () => signal.throwIfAborted(),
  };
  await prepareLocalWorkspaceCheckout(checkout);
  const unchanged = await fs.stat(path.join(destination, "unchanged"));
  await fs.mkdir(path.join(destination, "node_modules"));
  await fs.writeFile(path.join(destination, "node_modules", "dependency"), "installed\n");
  await fs.rm(path.join(source, "removed"));
  await fs.rm(path.join(source, "changed"));
  await fs.mkdir(path.join(source, "changed"));
  await fs.writeFile(path.join(source, "changed", "nested"), "next\n");
  await fs.writeFile(path.join(source, "versioned"), `${shared}next\n`);
  await git("add", ".");
  await git("commit", "--quiet", "-m", "next");
  const nextCommit = await git("rev-parse", "HEAD");
  await prepareLocalWorkspaceCheckout({
    ...checkout,
    baseCommit: nextCommit,
    retainedCommit: baseCommit,
  });
  await fs.writeFile(path.join(source, "added"), "third\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "third");
  const thirdCommit = await git("rev-parse", "HEAD");
  await prepareLocalWorkspaceCheckout({
    ...checkout,
    baseCommit: thirdCommit,
    retainedCommit: nextCommit,
  });
  expect(await worktreeGit.requireGit(destination, ["rev-parse", "HEAD"])).toBe(thirdCommit);
  expect(await worktreeGit.requireGit(destination, ["status", "--porcelain"])).toBe("");
  await worktreeGit.requireGit(destination, ["fsck", "--full"]);
  for (const absent of [baseCommit, nextCommit, deletedBlob, priorBlob]) {
    expect((await worktreeGit.runGit(destination, ["cat-file", "-e", absent])).code).not.toBe(0);
  }
  expect(await fs.readFile(path.join(destination, "changed", "nested"), "utf8")).toBe("next\n");
  expect(await fs.readFile(path.join(destination, "added"), "utf8")).toBe("third\n");
  expect(await fs.readFile(path.join(destination, "versioned"), "utf8")).toBe(`${shared}next\n`);
  await expect(fs.stat(path.join(destination, "removed"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.stat(path.join(destination, "unchanged"))).toMatchObject({
    ino: unchanged.ino,
    mtimeMs: unchanged.mtimeMs,
  });
  expect(await fs.readFile(path.join(destination, "node_modules", "dependency"), "utf8")).toBe(
    "installed\n",
  );
  expect(await fs.readFile(path.join(destination, ".git", "config"), "utf8")).not.toContain(
    "Checkout Test",
  );
});

it.each([
  ["win32", "NUL"],
  ["linux", "/dev/null"],
] as const)(
  "isolates checkout Git configuration and credentials on %s",
  async (platform, nullPath) => {
    const root = dirs.make("local-checkout-env-");
    const destination = path.join(root, "workspace");
    await fs.mkdir(path.join(destination, ".git"), { recursive: true });
    vi.stubEnv("PATH", "synthetic-git-path");
    for (const key of [
      "HOME",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_PARAMETERS",
      "GIT_DIR",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GITHUB_TOKEN",
    ]) {
      vi.stubEnv(key, "synthetic-host-only");
    }
    // Observe the process boundary without executing Windows Git on a POSIX host.
    vi.spyOn(checkoutConfig, "withWorktreeGitConfig").mockResolvedValue("fixture.pack");
    const git = vi.spyOn(worktreeGit, "requireGit").mockResolvedValue("");
    const stream = vi.spyOn(inventory, "runWorkspaceInventoryCommandToFile").mockResolvedValue();
    mockProcessPlatform(platform);
    await prepareLocalWorkspaceCheckout({
      source: path.join(root, "source"),
      destination,
      temporaryRoot: root,
      baseCommit: "a".repeat(40),
      branch: "openclaw/test",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: expect.stringContaining(path.join(root, "git-")),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullPath,
      GIT_CONFIG_SYSTEM: nullPath,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    expect(git.mock.calls.map(([, args]) => args[0])).toEqual(["init", "checkout"]);
    for (const options of git.mock.calls.map((call) => call[2])) {
      expect(options?.baseEnv).toEqual(cleanEnv);
      expect(options?.env).toEqual(cleanEnv);
    }
    const streamedEnv = stream.mock.calls[0]?.[0].baseEnv;
    expect(
      Object.fromEntries(
        Object.entries(streamedEnv!).filter(
          ([key]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/u.test(key),
        ),
      ),
    ).toEqual(cleanEnv);
    const config = Object.fromEntries(
      Array.from({ length: Number(streamedEnv?.GIT_CONFIG_COUNT) }, (_, i) => [
        streamedEnv?.[`GIT_CONFIG_KEY_${i}`],
        streamedEnv?.[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(config).toMatchObject({ "core.hooksPath": os.devNull, "core.fsmonitor": "false" });
  },
);
