import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareCandidateCommandEnv } from "./update-runner-git-commands.js";
import type { CommandRunner } from "./update-runner-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe("candidate command source isolation", () => {
  it.each(["pnpm", "npm", "bun"] as const)(
    "binds %s commands to candidate source without changing the caller",
    async (manager) => {
      const candidate = tempDirs.make("candidate-command-env-");
      const env = { OPENCLAW_DEV_SOURCE_ROOT: path.join(candidate, "installed"), KEEP: "value" };
      const original = { ...env };
      const runCommand = vi.fn<CommandRunner>().mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: "",
      });
      const prepared = await prepareCandidateCommandEnv(manager, env, candidate, runCommand, 1000);
      expect(prepared.env).toMatchObject({ OPENCLAW_DEV_SOURCE_ROOT: candidate, KEEP: "value" });
      expect(prepared.env).not.toBe(env);
      expect(env).toEqual(original);
    },
  );

  it("replaces an ambient serving source root when no command env was supplied", async () => {
    const candidate = tempDirs.make("candidate-command-env-");
    const serving = path.join(candidate, "installed");
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", serving);
    const runCommand = vi.fn<CommandRunner>();
    const prepared = await prepareCandidateCommandEnv(
      "npm",
      undefined,
      candidate,
      runCommand,
      1000,
    );
    expect(prepared.env?.OPENCLAW_DEV_SOURCE_ROOT).toBe(candidate);
    expect(process.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(serving);
  });
});
