import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readLatestConfigSnapshotAuditRecordAsync } from "../config/config-journal-snapshot.js";
import { readRecentConfigAuditRecords } from "../config/io.audit.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);
const operations = [
  { name: "set", args: ["config", "set", "logging.level", "warn"], level: "warn" },
  {
    name: "patch",
    args: ["config", "patch", "--stdin"],
    input: '{"logging":{"level":"warn"}}',
    level: "warn",
  },
  { name: "unset", args: ["config", "unset", "logging.level"], level: undefined },
  { name: "fast unset", args: ["config-unset-route", "logging.level"], level: undefined },
];

describe("config CLI database effects", () => {
  let env: NodeJS.ProcessEnv;
  let owner: GatewayLockHandle | null;
  let originalConfig: string;

  async function fixture(home: string): Promise<NodeJS.ProcessEnv> {
    const stateDir = path.join(home, "state");
    const configPath = path.join(home, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, logging: { level: "debug" } }),
    );
    return {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
  }

  beforeAll(async () => {
    env = await fixture(roots.make("openclaw-config-owner-"));
    originalConfig = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    owner = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
  });
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    await owner?.release();
  });

  it.each(operations)(
    "refuses $name before changing live-owned config",
    async ({ args, input }) => {
      const result = await runCliProcessChild({ nodeArgs: [...entrypoint, ...args], env, input });
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("exclusive offline state ownership");
      expect(result.stderr).toContain("stop the Gateway");
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(originalConfig);
      expect(await readLatestConfigSnapshotAuditRecordAsync({ env })).toBeNull();
    },
  );

  it.each(operations)(
    "persists $name and ancillary state while offline",
    async ({ args, input, level }) => {
      const home = roots.make("openclaw-config-offline-");
      const offline = await fixture(home);
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, ...args],
        env: offline,
        input,
      });
      expect(result.code, result.stderr).toBe(0);
      const raw = await fs.readFile(offline.OPENCLAW_CONFIG_PATH!, "utf8");
      expect(JSON.parse(raw).logging?.level).toBe(level);
      expect(
        await readLatestConfigSnapshotAuditRecordAsync({ env: offline, homedir: () => home }),
      ).toMatchObject({ rawHash: hashConfigRaw(raw) });
      expect(
        readRecentConfigAuditRecords({ env: offline, homedir: () => home, limit: 20 }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "config.write", result: "rename" }),
        ]),
      );
      expect(readConfigMachineState("config.lastTouchedAt", { env: offline })).toEqual(
        expect.any(String),
      );
    },
  );
});
