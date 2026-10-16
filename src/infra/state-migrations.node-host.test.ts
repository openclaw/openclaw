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
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;
const fixtureDigest = ["fixture", "digest"].join("-");
const gateway = {
  host: "gateway.example",
  port: 18443,
  tls: false,
  tlsFingerprint: fixtureDigest,
  contextPath: "/openclaw-gw",
};
const nodeIdentity = {
  version: 1 as const,
  nodeId: "legacy-node-id",
  displayName: "Legacy Node",
  gateway,
};
const canonicalConfig: NodeHostConfig = { ...nodeIdentity, installedAppsSharing: false };

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
      migrate: (
        hooks: Pick<
          Parameters<typeof migrateLegacyNodeHostConfig>[0],
          "beforeClaim" | "beforeVerify" | "removeSource"
        > = {},
      ) =>
        migrateLegacyNodeHostConfig({
          detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
          env,
          stateDir,
          ...hooks,
        }),
    };
  }

  function legacyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...nodeIdentity,
      token: "test-token-placeholder",
      ...overrides,
    };
  }

  async function writeLegacy(
    stateDir: string,
    value: unknown = legacyConfig(),
  ): Promise<{ mtimeMs: number; sourcePath: string }> {
    const sourcePath = path.join(stateDir, "node.json");
    await fsp.writeFile(sourcePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { sourcePath, mtimeMs: Math.floor((await fsp.stat(sourcePath)).mtimeMs) };
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
    const { stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    expect(detectLegacyNodeHostConfig({ stateDir }).hasLegacy).toBe(false);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
  });

  it("imports the complete snapshot, discards token, and removes node.json", async () => {
    const { env, stateDir, migrate } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Migrated node-host config to shared SQLite state.");
    await expect(loadNodeHostConfig(env)).resolves.toEqual(canonicalConfig);
    expect(readCanonicalRow(env)?.value).not.toHaveProperty("token");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("normalizes a legacy empty gateway context path to unset", async () => {
    const { env, stateDir, migrate } = useStateDir();
    await writeLegacy(stateDir, legacyConfig({ gateway: { ...gateway, contextPath: "" } }));

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect((await loadNodeHostConfig(env))?.gateway?.contextPath).toBeUndefined();
  });

  it("requires exclusive state ownership", async () => {
    const { env, stateDir, migrate } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_789,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let blocked: Awaited<ReturnType<typeof migrateLegacyNodeHostConfig>>;
    try {
      blocked = await migrate();
    } finally {
      await gatewayLock.release();
    }

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
    const { env, stateDir, migrate } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir, legacyConfig(overrides));
    const result = await migrate();

    expect(result.warnings[0]).toBe(
      `Failed reading legacy node-host state: Error: legacy node-host ${message}`,
    );
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("keeps a newer canonical snapshot with the same node id", async () => {
    const { env, stateDir, migrate } = useStateDir();
    const { mtimeMs, sourcePath } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      displayName: "Newer Canonical",
      gatewayHost: "newer.example",
      updatedAtMs: mtimeMs + 1_000,
    });
    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Kept newer canonical node-host SQLite state.");
    expect(readCanonicalRow(env)).toMatchObject({
      value: {
        displayName: "Newer Canonical",
        gateway: { host: "newer.example" },
      },
    });
    expect(readCanonicalRow(env)?.value).not.toHaveProperty("token");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("replaces an older canonical snapshot from the newer file", async () => {
    const { env, stateDir, migrate } = useStateDir();
    const { mtimeMs } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      displayName: "Older Canonical",
      gatewayHost: "older.example",
      updatedAtMs: mtimeMs - 1,
    });
    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(readCanonicalRow(env)).toMatchObject({
      value: {
        displayName: "Legacy Node",
        gateway: { host: "gateway.example" },
      },
      updatedAtMs: mtimeMs,
    });
  });

  it.each([
    ["different node id", { nodeId: "different-node", equalTimestamp: false }, "nodeId conflicts"],
    [
      "equal timestamp divergence",
      { nodeId: "legacy-node-id", equalTimestamp: true },
      "diverges at the same timestamp",
    ],
  ])("restores source on conflict: %s", async (_label, setup, message) => {
    const { env, stateDir, migrate } = useStateDir();
    const { mtimeMs, sourcePath } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      nodeId: setup.nodeId,
      displayName: "Divergent",
      updatedAtMs: setup.equalTimestamp ? mtimeMs : mtimeMs + 1,
    });
    const result = await migrate();

    expect(result.warnings[0]).toContain(message);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("fails before mutation when the source changes after parsing or before claim", async () => {
    const first = useStateDir();
    const firstLegacy = await writeLegacy(first.stateDir);
    const afterParse = await first.migrate({
      beforeVerify: () => fs.appendFileSync(firstLegacy.sourcePath, "\n"),
    });
    expect(afterParse.warnings[0]).toContain("source changed after Doctor loaded it");
    expect(readCanonicalRow(first.env)).toBeUndefined();

    const second = useStateDir();
    const secondLegacy = await writeLegacy(second.stateDir);
    const beforeClaim = await second.migrate({
      beforeClaim: () => fs.appendFileSync(secondLegacy.sourcePath, "\n"),
    });
    expect(beforeClaim.warnings[0]).toContain("source changed before Doctor could claim it");
    expect(readCanonicalRow(second.env)).toBeUndefined();
    expect(fs.existsSync(secondLegacy.sourcePath)).toBe(true);
  });

  it("retains a fixed claim on cleanup failure and retries idempotently", async () => {
    const { env, stateDir, migrate } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const first = await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(readCanonicalRow(env)?.value.nodeId).toBe("legacy-node-id");

    const retry = await migrate();
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(readCanonicalRow(env)?.value.nodeId).toBe("legacy-node-id");
  });

  it("refuses symlinked, hardlinked, and oversized sources", async () => {
    for (const link of [fsp.symlink, fsp.link]) {
      const { stateDir, migrate } = useStateDir();
      const outside = path.join(stateDir, "outside.json");
      await fsp.writeFile(outside, JSON.stringify(legacyConfig()), "utf8");
      await link(outside, path.join(stateDir, "node.json"));
      expect((await migrate()).warnings[0]).toContain("Failed reading legacy node-host state");
    }

    const oversizedCase = useStateDir();
    await fsp.writeFile(path.join(oversizedCase.stateDir, "node.json"), "x".repeat(65 * 1024));
    const oversizedResult = await oversizedCase.migrate();
    expect(oversizedResult.warnings[0]).toContain("Failed reading legacy node-host state");
  });

  it("fails cleanup when an old writer recreates node.json", async () => {
    const { env, stateDir, migrate } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const result = await migrate({
      removeSource: async (claimPath) => {
        await fsp.rm(claimPath);
        await fsp.writeFile(sourcePath, JSON.stringify(legacyConfig()), "utf8");
      },
    });

    expect(result.warnings[0]).toContain("source or Doctor claim remains after cleanup");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
  });
});
