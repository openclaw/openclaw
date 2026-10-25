// Covers fail-closed Doctor import of the retired node-host JSON config.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadNodeHostConfig,
  NODE_HOST_CONFIG_KEY,
  type NodeHostConfig,
} from "../node-host/config.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;
type MigrationHooks = Pick<
  Parameters<typeof migrateLegacyNodeHostConfig>[0],
  "beforeClaim" | "beforeVerify" | "removeSource"
>;
const gateway = {
  host: "gateway.example",
  port: 18443,
  tls: false,
  tlsFingerprint: ["fixture", "digest"].join("-"),
  contextPath: "/openclaw-gw",
};
const nodeIdentity = {
  version: 1 as const,
  nodeId: "legacy-node-id",
  displayName: "Legacy Node",
  gateway,
};
const canonicalConfig: NodeHostConfig = { ...nodeIdentity, installedAppsSharing: false };
const legacyConfig = { ...nodeIdentity, token: "test-token-placeholder" };

describe("legacy node-host Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir() {
    const stateDir = tempDirs.make("openclaw-node-host-migration-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    return {
      env,
      stateDir,
      migrate(this: void, hooks: MigrationHooks = {}) {
        return migrateLegacyNodeHostConfig({
          detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
          env,
          stateDir,
          ...hooks,
        });
      },
    };
  }

  async function legacyFixture(overrides: Record<string, unknown> = {}) {
    const fixture = useStateDir();
    const sourcePath = path.join(fixture.stateDir, "node.json");
    await fsp.writeFile(
      sourcePath,
      `${JSON.stringify({ ...legacyConfig, ...overrides }, null, 2)}\n`,
      "utf8",
    );
    return { ...fixture, sourcePath, mtimeMs: Math.floor((await fsp.stat(sourcePath)).mtimeMs) };
  }

  function seedCanonical(params: {
    env: NodeJS.ProcessEnv;
    nodeId?: string;
    displayName?: string;
    gatewayHost?: string;
    updatedAtMs: number;
  }): void {
    const database = openOpenClawStateDatabase({ env: params.env });
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<NodeHostConfigDatabase>(database.db)
        .insertInto("config_machine_state")
        .values({
          state_key: NODE_HOST_CONFIG_KEY,
          value_json: JSON.stringify({
            ...canonicalConfig,
            nodeId: params.nodeId ?? "legacy-node-id",
            displayName: params.displayName ?? "Legacy Node",
            gateway: { ...gateway, host: params.gatewayHost ?? gateway.host },
          } satisfies NodeHostConfig),
          updated_at_ms: params.updatedAtMs,
        }),
    );
  }

  function readCanonicalRow(env: NodeJS.ProcessEnv) {
    return readConfigMachineStateWithMetadata<NodeHostConfig>(NODE_HOST_CONFIG_KEY, { env });
  }

  it("detects source and interrupted claim only for explicit Doctor repair", async () => {
    const { stateDir, sourcePath } = await legacyFixture();
    const detect = () => detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true });
    expect(detectLegacyNodeHostConfig({ stateDir }).hasLegacy).toBe(false);
    expect(detect().hasLegacy).toBe(true);
    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(detect().hasLegacy).toBe(true);
  });

  it("imports the complete snapshot, discards token, and removes node.json", async () => {
    const { env, sourcePath, migrate } = await legacyFixture();
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Migrated node-host config to shared SQLite state.");
    await expect(loadNodeHostConfig(env)).resolves.toEqual(canonicalConfig);
    expect(readCanonicalRow(env)?.value).not.toHaveProperty("token");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("normalizes a legacy empty gateway context path to unset", async () => {
    const { env, migrate } = await legacyFixture({ gateway: { ...gateway, contextPath: "" } });
    expect((await migrate()).warnings).toEqual([]);
    expect((await loadNodeHostConfig(env))?.gateway?.contextPath).toBeUndefined();
  });

  it("retains malformed UTF-8 without importing replacement characters", async () => {
    const { env, sourcePath, migrate } = await legacyFixture({ displayName: "utf8-marker" });
    const bytes = await fsp.readFile(sourcePath);
    bytes[bytes.indexOf("utf8-marker")] = 0xff;
    await fsp.writeFile(sourcePath, bytes);
    const result = await migrate();
    expect(result.changes).toEqual([]);
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
    expect(await fsp.readFile(sourcePath)).toEqual(bytes);
    expect(readCanonicalRow(env)).toBeUndefined();
  });

  it("requires exclusive state ownership", async () => {
    const { env, sourcePath, migrate } = await legacyFixture();
    const blocked = await withGatewayLockHeld(env, 18_789, () => migrate());
    expect(blocked.warnings[0]).toContain("OpenClaw state database is busy");
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it.each([
    ["unknown top-level field", { unknown: true }, "config has unexpected field unknown"],
    ["empty top-level field", { "": 1, later: 2 }, 'config has unexpected field ""'],
    ["invalid version", { version: 2 }, "config version must be 1"],
    ["blank node id", { nodeId: " " }, "nodeId must be a non-empty string"],
    [
      "unknown gateway field",
      { gateway: { host: "gateway.example", unknown: true } },
      "gateway has unexpected field unknown",
    ],
    [
      "__proto__ gateway field",
      { gateway: { ["__proto__"]: 1, later: 2 } },
      "gateway has unexpected field __proto__",
    ],
    ["invalid token", { token: 42 }, "token must be a string when present"],
  ])("rejects strict legacy shape: %s", async (_label, overrides, message) => {
    const { env, sourcePath, migrate } = await legacyFixture(overrides);
    expect((await migrate()).warnings[0]).toBe(
      `Failed reading legacy node-host state: Error: legacy node-host ${message}`,
    );
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it.each([
    ["keeps newer", 1_000, "Newer Canonical", "newer.example"],
    ["replaces older", -1, "Older Canonical", "older.example"],
  ] as const)("%s canonical snapshot", async (_label, delta, displayName, host) => {
    const { env, mtimeMs, sourcePath, migrate } = await legacyFixture();
    seedCanonical({
      env,
      displayName,
      gatewayHost: host,
      updatedAtMs: mtimeMs + delta,
    });
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    const row = readCanonicalRow(env);
    expect(row).toMatchObject({
      value: {
        displayName: delta > 0 ? displayName : "Legacy Node",
        gateway: { host: delta > 0 ? host : "gateway.example" },
      },
      ...(delta < 0 ? { updatedAtMs: mtimeMs } : {}),
    });
    if (delta > 0) {
      expect(result.changes).toContain("Kept newer canonical node-host SQLite state.");
      expect(row?.value).not.toHaveProperty("token");
      expect(fs.existsSync(sourcePath)).toBe(false);
    }
  });

  it.each([
    ["different node id", { nodeId: "different-node", equalTimestamp: false }, "nodeId conflicts"],
    [
      "equal timestamp divergence",
      { nodeId: "legacy-node-id", equalTimestamp: true },
      "diverges at the same timestamp",
    ],
  ])("restores source on conflict: %s", async (_label, setup, message) => {
    const { env, mtimeMs, sourcePath, migrate } = await legacyFixture();
    seedCanonical({
      env,
      nodeId: setup.nodeId,
      displayName: "Divergent",
      updatedAtMs: setup.equalTimestamp ? mtimeMs : mtimeMs + 1,
    });
    expect((await migrate()).warnings[0]).toContain(message);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it.each([
    ["beforeVerify", "source changed after Doctor loaded it"],
    ["beforeClaim", "source changed before Doctor could claim it"],
  ] as const)("fails before mutation when source changes at %s", async (hook, warning) => {
    const { env, sourcePath, migrate } = await legacyFixture();
    expect(
      (await migrate({ [hook]: () => fs.appendFileSync(sourcePath, "\n") })).warnings[0],
    ).toContain(warning);
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("retains a fixed claim on cleanup failure and retries idempotently", async () => {
    const { env, sourcePath, migrate } = await legacyFixture();
    const first = await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(readCanonicalRow(env)?.value.nodeId).toBe("legacy-node-id");
    expect((await migrate()).warnings).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(readCanonicalRow(env)?.value.nodeId).toBe("legacy-node-id");
  });

  it("refuses symlinked, hardlinked, and oversized sources", async () => {
    for (const link of [fsp.symlink, fsp.link]) {
      const { stateDir, migrate } = useStateDir();
      const outside = path.join(stateDir, "outside.json");
      await fsp.writeFile(outside, JSON.stringify(legacyConfig), "utf8");
      await link(outside, path.join(stateDir, "node.json"));
      expect((await migrate()).warnings[0]).toContain("Failed reading legacy node-host state");
    }
    const oversizedCase = useStateDir();
    await fsp.writeFile(path.join(oversizedCase.stateDir, "node.json"), "x".repeat(65 * 1024));
    const oversizedResult = await oversizedCase.migrate();
    expect(oversizedResult.warnings[0]).toContain("Failed reading legacy node-host state");
  });

  it("fails cleanup when an old writer recreates node.json", async () => {
    const { env, sourcePath, migrate } = await legacyFixture();
    const result = await migrate({
      removeSource: async (claimPath) => {
        await fsp.rm(claimPath);
        await fsp.writeFile(sourcePath, JSON.stringify(legacyConfig), "utf8");
      },
    });
    expect(result.warnings[0]).toContain("source or Doctor claim remains after cleanup");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
  });
});
