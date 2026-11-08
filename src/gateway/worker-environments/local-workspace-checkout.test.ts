import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  const retired = [deletedBlob, priorBlob];
  let retainedCommit = baseCommit;
  for (const revision of ["next", "third"]) {
    retired.push(retainedCommit);
    await fs.writeFile(path.join(source, "versioned"), `${shared}${revision}\n`);
    await git("add", ".");
    await git("commit", "--quiet", "-m", revision);
    const nextCommit = await git("rev-parse", "HEAD");
    await prepareLocalWorkspaceCheckout({ ...checkout, baseCommit: nextCommit, retainedCommit });
    retainedCommit = nextCommit;
  }
  expect(await worktreeGit.requireGit(destination, ["rev-parse", "HEAD"])).toBe(retainedCommit);
  expect(await worktreeGit.requireGit(destination, ["status", "--porcelain"])).toBe("");
  await worktreeGit.requireGit(destination, ["fsck", "--full"]);
  for (const absent of retired) {
    expect((await worktreeGit.runGit(destination, ["cat-file", "-e", absent])).code).not.toBe(0);
  }
  expect(await fs.readFile(path.join(destination, "changed", "nested"), "utf8")).toBe("next\n");
  expect(await fs.readFile(path.join(destination, "versioned"), "utf8")).toBe(`${shared}third\n`);
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
      "GIT_WORK_TREE",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GITHUB_TOKEN",
    ]) {
      vi.stubEnv(key, "synthetic-host-only");
    }
    // Observe the process boundary without executing Windows Git on a POSIX host.
    vi.spyOn(checkoutConfig, "withWorktreeGitConfig").mockResolvedValue("fixture.pack");
    const git = vi.spyOn(worktreeGit, "requireGit").mockResolvedValue("");
    const origin = vi.spyOn(worktreeGit, "runGit").mockResolvedValue({
      code: 0,
      stdout: "https://github.com/example/projection.git",
      stderr: "",
      termination: "exit",
      signal: null,
      killed: false,
      timeoutMs: 30_000,
    });
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
    expect(git.mock.calls.map(([, args]) => args[0])).toEqual(
      expect.arrayContaining(["init", "checkout", "config"]),
    );
    for (const options of [...git.mock.calls, ...origin.mock.calls].map((call) => call[2])) {
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

it("filters URL and named-remote fetches without sharing host objects or credentials", async () => {
  const root = dirs.make("local-checkout-fetch-");
  const source = path.join(root, "source");
  const url = "https://github.com/example/projection";
  await fs.mkdir(source);
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  vi.stubEnv("GIT_CONFIG_SYSTEM", os.devNull);
  const git = (cwd: string, ...args: string[]) => worktreeGit.requireGit(cwd, args);
  await git(source, "init", "--quiet");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  await git(source, "config", "uploadpack.allowFilter", "true");
  const heads: string[] = [];
  for (let revision = 0; revision < 5; revision++) {
    await fs.writeFile(path.join(source, "source.txt"), `revision ${revision}\n`);
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", `revision ${revision}`);
    heads.push(await git(source, "rev-parse", "HEAD"));
  }
  const obsoleteBlob = await git(source, "rev-parse", `${heads[0]}:source.txt`);
  await git(
    source,
    "config",
    "remote.origin.url",
    "https://fixture:synthetic-password@github.com/example/projection.git",
  );
  await git(source, "config", "credential.helper", "!echo synthetic-host-helper");
  const sourceConfig = await fs.readFile(path.join(source, ".git/config"), "utf8");
  const poisoned = {
    GIT_DIR: path.join(source, ".git"),
    GIT_WORK_TREE: source,
    GIT_CONFIG_PARAMETERS: "'remote.origin.url=https://github.com/ambient/poison.git'",
  };
  for (const [index, remote] of [url, `${url}.git`, "origin"].entries()) {
    const destination = path.join(root, `projection-${index}`);
    for (const [key, value] of Object.entries(poisoned)) {
      vi.stubEnv(key, value);
    }
    await prepareLocalWorkspaceCheckout({
      source,
      destination,
      temporaryRoot: root,
      baseCommit: heads[4]!,
      branch: "guest",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    for (const key of Object.keys(poisoned)) {
      vi.stubEnv(key, undefined);
    }
    expect(await fs.readFile(path.join(source, ".git/config"), "utf8")).toBe(sourceConfig);
    expect(await git(destination, "config", "--get", "remote.origin.url")).toBe(`${url}.git`);
    const config = await fs.readFile(path.join(destination, ".git/config"), "utf8");
    expect(config).not.toMatch(/synthetic-password|synthetic-host-helper/);
    await expect(fs.stat(path.join(destination, ".git/objects/info/alternates"))).rejects.toThrow();
    const fetch = (...args: string[]) =>
      git(
        destination,
        "-c",
        `url.${pathToFileURL(source).href}.insteadOf=${url}`,
        "-c",
        `url.${pathToFileURL(source).href}.insteadOf=${url}.git`,
        ...args,
      );
    await fetch("fetch", "--no-tags", remote, ...heads.slice(1, 4));
    // Inspect only present objects; asking cat-file for a missing blob would fetch it.
    expect(
      await git(destination, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"),
    ).not.toContain(obsoleteBlob);
    expect(await git(destination, "log", "-1", "--format=%s", heads[3]!)).toBe("revision 3");
    await fetch("checkout", "--quiet", "--detach", heads[3]!);
    expect(await fs.readFile(path.join(destination, "source.txt"), "utf8")).toBe("revision 3\n");
    expect(await git(destination, "status", "--porcelain")).toBe("");
    await fs.writeFile(path.join(destination, "source.txt"), "guest change\n");
    expect(await git(destination, "diff")).toContain("+guest change");
    await git(destination, "add", ".");
    await git(
      destination,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "guest change",
    );
  }
});
