import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";
import { getCliProcessTestTimeout, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runApprovalsCliProcess(args: string[]) {
  const root = tempDirs.make("openclaw-approvals-process-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(stateDir, { recursive: true });
  await writeFixtureJson(configPath, { logging: { consoleStyle: "json", level: "silent" } });
  return runCliProcessChild({
    nodeArgs: ["--import", "tsx", "src/entry.ts", ...args],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      VITEST: undefined,
    },
  });
}

describe("exec approvals CLI process", () => {
  it.each([
    ["approvals get", ["approvals", "get", "--gateway", "--node", "macbook"]],
    [
      "approvals allowlist add",
      ["approvals", "allowlist", "add", "/usr/bin/uname", "--gateway", "--node", "macbook"],
    ],
  ])(
    "rejects %s from the shipped CLI before any policy access",
    async (_label, args) => {
      const result = await runApprovalsCliProcess(args);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Pass only one of --gateway or --node.");
    },
    getCliProcessTestTimeout(120_000),
  );

  it(
    "leaves a single --gateway target unaffected by the conflict check",
    async () => {
      const result = await runApprovalsCliProcess(["approvals", "get", "--gateway"]);
      expect(result.signal).toBeNull();
      expect(result.code).not.toBe(0);
      // The command passes the conflict check and fails later at gateway auth,
      // not with the conflicting-target message.
      expect(result.stderr).not.toContain("Pass only one of --gateway or --node.");
    },
    getCliProcessTestTimeout(120_000),
  );
});
