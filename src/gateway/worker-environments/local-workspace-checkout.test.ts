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
