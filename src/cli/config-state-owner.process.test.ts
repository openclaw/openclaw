import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readLatestConfigSnapshotAuditRecordAsync } from "../config/config-journal-snapshot.js";
import { readRecentConfigAuditRecords } from "../config/io.audit.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { runStateOwnerCli as run, stateOwnerEnv } from "./cli-process-fixture.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
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
    return stateOwnerEnv(home);
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

  it.each(
    operations.flatMap((operation) => [
      { ...operation, mode: "preview", flags: ["--dry-run"], code: 0 },
      { ...operation, mode: "write", flags: [], code: 1 },
    ]),
  )("$name $mode respects live state ownership", async ({ args, input, flags, code }) => {
    const result = await run(env, [...args, ...flags], input);
    expect(result.code, result.stderr).toBe(code);
    if (code === 1) {
      // Writes route to a Gateway listener; this owner holds custody without one.
      expect(result.stderr).toContain("The state owner has no Gateway listener");
      expect(result.stderr).toContain("No local mutation was attempted");
      expect(result.stderr).toContain("stop the Gateway");
    }
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(originalConfig);
    expect(await readLatestConfigSnapshotAuditRecordAsync({ env })).toBeNull();
  });

  it("does not bootstrap state for an unchanged config value", async () => {
    const offline = await fixture(roots.make("openclaw-config-unchanged-"));
    const result = await run(offline, ["config", "set", "logging.level", "debug"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("No change");
    await expect(
      fs.access(path.join(offline.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(operations)(
    "persists $name and ancillary state while offline",
    async ({ args, input, level }) => {
      const home = roots.make("openclaw-config-offline-");
      const offline = await fixture(home);
      const result = await run(offline, args, input);
      expect(result.code, result.stderr).toBe(0);
      const raw = await fs.readFile(offline.OPENCLAW_CONFIG_PATH!, "utf8");
      expect(JSON.parse(raw).logging?.level).toBe(level);
      expect(
        await readLatestConfigSnapshotAuditRecordAsync({ env: offline, homedir: () => home }),
      ).toMatchObject({ rawHash: hashConfigRaw(raw) });
      const audit = readRecentConfigAuditRecords({ env: offline, homedir: () => home, limit: 20 });
      expect(audit).toContainEqual(
        expect.objectContaining({ event: "config.write", result: "rename" }),
      );
      expect(readConfigMachineState("config.lastTouchedAt", { env: offline })).toEqual(
        expect.any(String),
      );
    },
  );
});
