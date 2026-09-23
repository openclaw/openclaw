import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createTempHome(): Promise<string> {
  return tempDirs.make("openclaw-mcp-probe-process-");
}

async function writeConfig(home: string, servers: Record<string, unknown>): Promise<string> {
  const configPath = path.join(home, "openclaw.json");
  await fs.writeFile(configPath, `${JSON.stringify({ mcp: { servers } })}\n`, "utf8");
  return configPath;
}

function runProbe(home: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  // Config observation starts SQLite workers; use the prepared CLI graph so
  // source compilation does not consume the command's exit deadline.
  return runCliProcessChild({
    nodeArgs: [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
      ...args,
    ],
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeoutMs: 30_000,
  });
}

describe("mcp probe process exit", () => {
  it("prints named JSON diagnostics before exiting nonzero", async () => {
    const home = await createTempHome();
    const configPath = await writeConfig(home, {
      broken: { command: path.join(home, "missing-mcp-server") },
    });

    const result = await runProbe(home, ["mcp", "probe", "broken", "--json"]);
    const failure = formatCliProcessFailure({ reason: "MCP probe child failed", ...result });

    expect(result.signal, failure).toBeNull();
    expect(result.code, failure).toBe(1);
    const output = JSON.parse(result.stdout) as {
      diagnostics: Array<{ message: string; serverName: string }>;
      servers: Record<string, unknown>;
    };
    expect(output.servers).toEqual({});
    expect(output.diagnostics).toEqual([expect.objectContaining({ serverName: "broken" })]);
    expect(result.stderr).toContain(`MCP probe failed for "broken" in ${configPath}:`);
  });
});
