import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";
import * as healthOwner from "./io.health-state.js";
import { readConfigHealthStateFromStore } from "./io.health-state.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { withTempHomeConfig } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("accepted writer recovery baseline", () => {
  function acceptedWriteFixture() {
    const root = tempDirs.make("openclaw-config-lgg-accepted-write-");
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const env = {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const io = createConfigIO({
      env,
      configPath,
      homedir: () => root,
      observe: false,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    return { configPath, env, io, root };
  }

  function seedConfig(configPath: string, config: Record<string, unknown>): string {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(configPath, raw, "utf8");
    return raw;
  }

  it("promotes an accepted formatting normalization over the verbose baseline", async () => {
    const { configPath, io, env, root } = acceptedWriteFixture();
    const lastGoodPath = `${configPath}.last-good`;
    const original = {
      meta: { lastTouchedVersion: "2026.4.23" },
      gateway: { mode: "local" },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
        },
      },
    };
    // Verbose PowerShell formatting (BOM + 12-space indent): canonical writes
    // shrink raw bytes by more than half through serialization alone.
    const powerShellRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
    fs.writeFileSync(configPath, powerShellRaw, "utf8");

    const verboseSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(verboseSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(powerShellRaw);

    // An ordinary accepted edit without allowConfigSizeDrop: the writer's
    // canonicalized size baseline records no drop, so the raw-byte shrink comes
    // purely from formatting normalization.
    const capture = healthOwner.captureConfigHealthStateStore;
    let interleaved = false;
    const captureSpy = vi
      .spyOn(healthOwner, "captureConfigHealthStateStore")
      .mockImplementation((...args) => {
        const store = capture(...args);
        const update = store.updateAfterFileCommit.bind(store);
        store.updateAfterFileCommit = async (...updates) => {
          if (!interleaved) {
            interleaved = true;
            await createConfigIO({
              env,
              configPath,
              homedir: () => root,
              logger: { warn: vi.fn(), error: vi.fn() },
            }).readConfigFileSnapshot();
          }
          return update(...updates);
        };
        return store;
      });
    await io.writeConfigFile(
      { ...original, gateway: { mode: "local", port: 18789 } },
      { baseSnapshot: verboseSnapshot },
    );
    captureSpy.mockRestore();
    expect(interleaved).toBe(true);
    const canonicalRaw = fs.readFileSync(configPath, "utf8");
    expect(Buffer.byteLength(powerShellRaw, "utf8")).toBeGreaterThan(
      Buffer.byteLength(canonicalRaw, "utf8") * 2,
    );

    // The accepted write advanced the last-known-good baseline, so the next
    // startup promotes the edited canonical config instead of freezing the
    // verbose one as the recovery target.
    const editedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(editedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);

    // An external truncation afterwards never advances the baseline: promotion
    // keeps refusing it, and recovery restores the edited canonical config.
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
      "utf8",
    );
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(truncatedSnapshot)).resolves.toBe(false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);

    fs.writeFileSync(configPath, "{ gateway: { mode: 123 } }\n", "utf8");
    const brokenSnapshot = await io.readConfigFileSnapshot();
    await expect(
      io.recoverConfigFromLastKnownGood({
        snapshot: brokenSnapshot,
        reason: "test-formatting-baseline",
      }),
    ).resolves.toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(canonicalRaw);
  });

  it("restores the last-known-good baseline when a committed write rolls back", async () => {
    const initialConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 40 }, (_, index) => `192.0.2.${index}`),
      },
    };
    await withTempHomeConfig(initialConfig, async ({ home, configPath }) => {
      const lastGoodPath = `${configPath}.last-good`;
      const originalRaw = await fsp.readFile(configPath, "utf-8");
      const io = createConfigIO({ observe: false });
      const healthDeps = { env: io.env, homedir: () => home, logger: console };
      const readLastKnownGood = () =>
        readConfigHealthStateFromStore(healthDeps).entries?.[configPath]?.lastKnownGood;

      const healthySnapshot = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(healthySnapshot)).resolves.toBe(true);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
      const baselineBefore = readLastKnownGood();
      expect(baselineBefore?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

      // Grow the config beyond twice its size, then fail runtime activation after
      // the commit so the write rolls back to the original bytes.
      const failure = new Error("synthetic overlay failure");
      const grownConfig = {
        ...initialConfig,
        gateway: {
          mode: "local" as const,
          trustedProxies: Array.from({ length: 400 }, (_, index) => `192.0.2.${index}`),
        },
      };
      expect(
        Buffer.byteLength(`${JSON.stringify(grownConfig, null, 2)}\n`, "utf-8"),
      ).toBeGreaterThan(Buffer.byteLength(originalRaw, "utf-8") * 2);
      const unsubscribe = registerConfigWriteListener(vi.fn(), {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          reapplyRuntimeOverlays() {
            throw failure;
          },
          reapplyCompareOverlays: (config) => config,
        }),
      });
      try {
        setRuntimeConfigSnapshot(initialConfig, initialConfig);
        await expect(writeConfigFile(grownConfig)).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
          cause: failure,
        });
      } finally {
        unsubscribe();
        resetConfigRuntimeState();
      }

      // The rollback restored the original bytes and the pre-write baseline, so
      // the restored config is not a size drop against the baseline.
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      const baselineAfter = readLastKnownGood();
      expect(baselineAfter?.hash).toBe(baselineBefore?.hash);
      expect(baselineAfter?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

      const restoredSnapshot = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(restoredSnapshot)).resolves.toBe(true);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
    });
  });

  it("retains input mode loss through accepted edits that restore its shape", async () => {
    const { configPath, io, env, root } = acceptedWriteFixture();
    const observed = createConfigIO({
      env,
      configPath,
      homedir: () => root,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const original = seedConfig(configPath, {
      gateway: { mode: "local", port: 19091, trustedProxies: ["192.0.2.1"] },
    });
    expect(Buffer.byteLength(original)).toBeLessThan(512);
    expect(await io.promoteConfigSnapshotToLastKnownGood(await io.readConfigFileSnapshot())).toBe(
      true,
    );
    seedConfig(configPath, {});
    const truncated = await observed.readConfigFileSnapshot();
    await observed.writeConfigFile(
      { gateway: { mode: "local", port: 19092 } },
      { baseSnapshot: truncated },
    );
    const edited = await observed.readConfigFileSnapshot();
    expect(await io.promoteConfigSnapshotToLastKnownGood(edited)).toBe(false);
    await observed.writeConfigFile(
      { ...edited.config, gateway: { mode: "local", port: 19093 } },
      { baseSnapshot: edited },
    );
    expect(
      await io.promoteConfigSnapshotToLastKnownGood(await observed.readConfigFileSnapshot()),
    ).toBe(false);
    expect(fs.readFileSync(configPath + ".last-good", "utf8")).toBe(original);
  });
  it.each(["conflict", "unavailable"] as const)(
    "retries only a definite %s outcome after an accepted write",
    async (outcome) => {
      const { configPath, io } = acceptedWriteFixture();
      seedConfig(configPath, { gateway: { mode: "local", port: 19091 } });
      const before = await io.readConfigFileSnapshot();
      expect(await io.promoteConfigSnapshotToLastKnownGood(before)).toBe(true);
      const capture = healthOwner.captureConfigHealthStateStore;
      let attempts = 0;
      vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
        const store = capture(...args);
        const update = store.updateAfterFileCommit.bind(store);
        store.updateAfterFileCommit = async (...updates) => {
          attempts += 1;
          if (attempts === 1) {
            return { status: outcome };
          }
          return update(...updates);
        };
        return store;
      });
      await io.writeConfigFile(
        { gateway: { mode: "local", port: 19092 } },
        { baseSnapshot: before },
      );
      expect(attempts).toBe(outcome === "conflict" ? 2 : 1);
    },
  );

  it("preserves the complete newer external-truncation decision during accepted normalization", async () => {
    const root = tempDirs.make("config-review-marker-");
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    };
    const options = {
      env,
      configPath,
      homedir: () => root,
      logger: { warn: vi.fn(), error: vi.fn() },
    };
    const io = createConfigIO({ ...options, observe: false });
    const observed = createConfigIO(options);
    const original = {
      meta: { lastTouchedVersion: "2026.4.23" },
      gateway: { mode: "local" as const, port: 19091 },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, i) => "telegram:" + i),
        },
      },
    };
    const raw = "﻿" + JSON.stringify(original, null, 12) + "\n";
    fs.writeFileSync(configPath, raw);
    const before = await io.readConfigFileSnapshot();
    expect(await io.promoteConfigSnapshotToLastKnownGood(before)).toBe(true);
    const originalEntry = healthOwner.readConfigHealthStateFromStore(options).entries?.[configPath];
    const capture = healthOwner.captureConfigHealthStateStore;
    let interleaved = false;
    let newerSignature: string | null | undefined;
    let externalRaw = "";
    let candidateRaw = "";
    vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
      const store = capture(...args);
      const update = store.updateAfterFileCommit.bind(store);
      store.updateAfterFileCommit = async (...updates) => {
        if (!interleaved) {
          interleaved = true;
          candidateRaw = fs.readFileSync(configPath, "utf8");
          const candidate = JSON.parse(candidateRaw);
          candidate.channels.telegram.allowFrom = candidate.channels.telegram.allowFrom.slice(
            0,
            50,
          );
          externalRaw = JSON.stringify(candidate, null, 2) + "\n";
          fs.writeFileSync(configPath, externalRaw);
          await observed.readConfigFileSnapshot();
          newerSignature =
            healthOwner.readConfigHealthStateFromStore(options).entries?.[configPath]
              ?.lastObservedSuspiciousSignature;
          expect(newerSignature).toContain("size-drop-vs-last-good:");
        }
        return update(...updates);
      };
      return store;
    });
    await io.writeConfigFile(
      { ...original, gateway: { mode: "local", port: 19092 } },
      { baseSnapshot: before },
    );
    vi.restoreAllMocks();
    expect(interleaved).toBe(true);
    expect(Buffer.byteLength(externalRaw)).toBeLessThan(Buffer.byteLength(raw) / 2);
    expect(Buffer.byteLength(externalRaw)).toBeGreaterThan(Buffer.byteLength(candidateRaw) / 2);
    const afterSettle = healthOwner.readConfigHealthStateFromStore(options).entries?.[configPath];
    const externalSnapshot = await observed.readConfigFileSnapshot();
    const promoted = await io.promoteConfigSnapshotToLastKnownGood(externalSnapshot);
    expect(afterSettle?.lastObservedSuspiciousSignature).toBe(newerSignature);
    expect(afterSettle?.lastKnownGood).toEqual(originalEntry?.lastKnownGood);
    expect(afterSettle?.lastPromotedGood).toEqual(originalEntry?.lastPromotedGood);
    expect(promoted).toBe(false);
    expect(fs.readFileSync(configPath + ".last-good", "utf8")).toBe(raw);
  });
});
