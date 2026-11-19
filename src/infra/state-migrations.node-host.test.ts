// Covers fail-closed Doctor import of the retired node-host JSON config.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadNodeHostConfig,
  NODE_HOST_CONFIG_KEY as configKey,
  type NodeHostConfig,
} from "../node-host/config.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";

type MigrationHooks = Pick<
  Parameters<typeof migrateLegacyNodeHostConfig>[0],
  "beforeClaim" | "beforeVerify" | "removeSource"
>;
const gateway = {
  host: "gateway.example",
  port: 18443,
  tls: false,
  tlsFingerprint: "fixture-digest",
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
      read: () => readConfigMachineStateWithMetadata<NodeHostConfig>(configKey, { env }),
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

  function legacyFixture(overrides: Record<string, unknown> = {}) {
    const fixture = useStateDir();
    const sourcePath = path.join(fixture.stateDir, "node.json");
    fs.writeFileSync(sourcePath, JSON.stringify({ ...legacyConfig, ...overrides }));
    return { ...fixture, sourcePath, mtimeMs: Math.floor(fs.statSync(sourcePath).mtimeMs) };
  }

  function seedCanonical(
    env: NodeJS.ProcessEnv,
    updatedAtMs: number,
    config: Partial<NodeHostConfig>,
  ) {
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        updateConfigMachineStateInDatabase(
          db,
          configKey,
          () => ({ ...canonicalConfig, ...config }),
          updatedAtMs,
        ),
      { env },
    );
  }

  function expectUnimported({ read, sourcePath }: ReturnType<typeof legacyFixture>) {
    expect(read()).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  }

  it("detects source and interrupted claim only for explicit Doctor repair", async () => {
    const { stateDir, sourcePath } = legacyFixture();
    const detect = () => detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true });
    expect(detectLegacyNodeHostConfig({ stateDir }).hasLegacy).toBe(false);
    expect(detect().hasLegacy).toBe(true);
    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(detect().hasLegacy).toBe(true);
  });

  it("normalizes a legacy empty gateway context path to unset", async () => {
    const { env, migrate } = legacyFixture({ gateway: { ...gateway, contextPath: "" } });
    expect((await migrate()).warnings).toEqual([]);
    expect((await loadNodeHostConfig(env))?.gateway?.contextPath).toBeUndefined();
  });

  it.each(["source", "claim", "pair"] as const)(
    "retains malformed UTF-8 %s bytes before recovery and accepts corrected Unicode",
    async (kind) => {
      const displayName = "Café 会议 �";
      const { env, sourcePath, migrate, read } = legacyFixture({ displayName });
      const valid = await fsp.readFile(sourcePath, "utf8");
      const malformed = Buffer.from(valid, "latin1");
      const claimPath = `${sourcePath}.doctor-importing`;
      const originals = new Map([[sourcePath, malformed]]);
      await fsp.writeFile(sourcePath, malformed);
      if (kind === "claim") {
        await fsp.rename(sourcePath, claimPath);
        originals.delete(sourcePath);
        originals.set(claimPath, malformed);
      } else if (kind === "pair") {
        const claim = Buffer.from(malformed);
        claim[claim.indexOf(0xe9)] = 0xea;
        await fsp.writeFile(claimPath, claim);
        originals.set(claimPath, claim);
      }

      const refused = await migrate();
      expect(refused.changes).toEqual([]);
      expect(refused.warningDisposition).toBe("recoverable");
      expect(refused.warnings.join("\n")).toContain("must be valid UTF-8");
      expect(refused.warnings.join("\n")).toMatch(/Back up .+, replace it .*retry Doctor/);
      expect(read()).toBeUndefined();
      for (const [file, bytes] of originals) {
        expect(await fsp.readFile(file)).toEqual(bytes);
        await fsp.writeFile(file, valid);
      }

      expect((await migrate()).warnings).toEqual([]);
      await expect(loadNodeHostConfig(env)).resolves.toMatchObject({ displayName });
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(claimPath)).toBe(false);
    },
  );

  it("requires exclusive state ownership", async () => {
    const fixture = legacyFixture();
    const blocked = await withGatewayLockHeld(fixture.env, 18_789, fixture.migrate);
    expect(blocked.warnings[0]).toContain("OpenClaw state database is busy");
    expectUnimported(fixture);
  });

  it.each([
    [{ "": 1, later: 2 }, 'config has unexpected field ""'],
    [{ version: 2 }, "config version must be 1"],
    [{ nodeId: " " }, "nodeId must be a non-empty string"],
    [{ gateway: { ["__proto__"]: 1 } }, "gateway has unexpected field __proto__"],
    [{ token: 42 }, "token must be a string when present"],
  ])("rejects strict legacy shape: %j", async (overrides, message) => {
    const fixture = legacyFixture(overrides);
    expect((await fixture.migrate()).warnings[0]).toBe(
      `Failed reading legacy node-host state: Error: legacy node-host ${message}`,
    );
    expectUnimported(fixture);
    expect(fs.existsSync(`${fixture.sourcePath}.doctor-importing`)).toBe(false);
  });

  it.each([
    ["keeps newer", 1_000, "Newer Canonical", "newer.example"],
    ["replaces older", -1, "Older Canonical", "older.example"],
  ] as const)("%s canonical snapshot", async (_label, delta, displayName, host) => {
    const { env, mtimeMs, sourcePath, migrate, read } = legacyFixture();
    seedCanonical(env, mtimeMs + delta, { displayName, gateway: { ...gateway, host } });
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    const row = read();
    expect(row).toMatchObject({
      value: {
        displayName: delta > 0 ? displayName : "Legacy Node",
        gateway: { host: delta > 0 ? host : "gateway.example" },
      },
      ...(delta < 0 ? { updatedAtMs: mtimeMs } : {}),
    });
    if (delta > 0) {
      expect(row?.value).not.toHaveProperty("token");
      expect(fs.existsSync(sourcePath)).toBe(false);
    }
  });

  it.each([
    ["different-node", 1, "nodeId conflicts"],
    ["legacy-node-id", 0, "diverges at the same timestamp"],
  ] as const)("restores source on conflict: %s", async (nodeId, delta, message) => {
    const { env, mtimeMs, sourcePath, migrate } = legacyFixture();
    seedCanonical(env, mtimeMs + delta, { nodeId, displayName: "Divergent" });
    expect((await migrate()).warnings[0]).toContain(message);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it.each([
    ["beforeVerify", "source changed after Doctor loaded it"],
    ["beforeClaim", "source changed before Doctor could claim it"],
  ] as const)("fails before mutation when source changes at %s", async (hook, warning) => {
    const fixture = legacyFixture();
    expect(
      (await fixture.migrate({ [hook]: () => fs.appendFileSync(fixture.sourcePath, "\n") }))
        .warnings[0],
    ).toContain(warning);
    expectUnimported(fixture);
  });

  it("retains a fixed claim on cleanup failure and retries idempotently", async () => {
    const { sourcePath, migrate, read } = legacyFixture();
    const first = await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(read()?.value.nodeId).toBe("legacy-node-id");
    expect(read()?.value).not.toHaveProperty("token");
    expect((await migrate()).warnings).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(read()?.value.nodeId).toBe("legacy-node-id");
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
    const { env, sourcePath, migrate } = legacyFixture();
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
