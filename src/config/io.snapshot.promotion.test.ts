import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { createConfigIO } from "./io.factory.js";
import * as healthOwner from "./io.health-state.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { promoteConfigSnapshotToLastKnownGoodCore } from "./io.observe-promotion.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import {
  advanceConfigHealthBaselineForAcceptedWrite,
  captureConfigHealthBaselineForWrite,
  observeConfigSnapshotSync,
  restoreConfigHealthBaselineForRolledBackWrite,
} from "./io.observe.js";
import { hashConfigRaw, normalizeConfigIoDeps } from "./io.read-helpers.js";
import { configWritePostCommitRollback } from "./io.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const home = dirs.make("config-promotion-");
  const configPath = path.join(home, "openclaw.json");
  const deps = normalizeConfigIoDeps({
    env: { HOME: home, OPENCLAW_STATE_DIR: home, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  function snapshot(parsed: OpenClawConfig, raw = JSON.stringify(parsed, null, 2) + "\n") {
    fs.writeFileSync(configPath, raw);
    return {
      path: configPath,
      exists: true,
      raw,
      parsed,
      resolved: parsed,
      sourceConfig: parsed,
      config: parsed,
      runtimeConfig: parsed,
      valid: true,
      issues: [],
      warnings: [],
      legacyIssues: [],
    } satisfies ConfigFileSnapshot;
  }
  const healthy = snapshot({
    gateway: {
      mode: "local",
      trustedProxies: Array.from({ length: 60 }, (_, i) => "192.0.2." + i),
    },
  });
  const entry = () => healthOwner.readConfigHealthStateFromStore(deps).entries?.[configPath];
  const promote = (value: ConfigFileSnapshot) =>
    promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: value });
  return { deps, configPath, healthy, snapshot, entry, promote };
}

it("preserves the healthy recovery file after parseable external truncation", async () => {
  const f = fixture();
  expect(await f.promote(f.healthy)).toBe(true);
  const truncated = f.snapshot({ gateway: { mode: "local" } });
  observeConfigSnapshotSync(f.deps, truncated);
  const before = f.entry();
  expect(await f.promote(truncated)).toBe(false);
  expect(fs.readFileSync(f.configPath + ".last-good", "utf8")).toBe(f.healthy.raw);
  expect(f.entry()).toEqual(before);
});

it.each(["reduction", "formatting"] as const)(
  "promotes an accepted %s and compensates a rolled-back writer",
  async (kind) => {
    const f = fixture();
    const initial =
      kind === "formatting"
        ? f.snapshot(f.healthy.config, "\ufeff" + JSON.stringify(f.healthy.config, null, 16) + "\n")
        : f.healthy;
    expect(await f.promote(initial)).toBe(true);
    const io = createConfigIO({ ...f.deps, configPath: f.configPath, observe: false });
    const result = await io.writeConfigFile(
      kind === "formatting" ? initial.config : { gateway: { mode: "local", port: 19201 } },
      { allowConfigSizeDrop: true },
    );
    expect(f.entry()?.lastKnownGood?.hash).toBe(result.persistedHash);
    const written = await io.readConfigFileSnapshot();
    expect(await f.promote(written)).toBe(true);
    const rollback = result[configWritePostCommitRollback];
    expect(rollback).toBeDefined();
    expect(await rollback!.restoreFile(() => {})).toBe(true);
    // The independent promotion is a newer health decision, so compensation leaves it alone.
    const afterPromotion = f.entry();
    await rollback!.restoreEffects(() => {});
    expect(f.entry()).toEqual(afterPromotion);
  },
);

it("retains inherited anomalies through repeated metadata-stamped writes", async () => {
  const f = fixture();
  await f.promote(f.healthy);
  f.snapshot({ gateway: { mode: "local" } });
  const io = createConfigIO({ ...f.deps, configPath: f.configPath, observe: false });
  for (const port of [19201, 19202]) {
    const result = await io.writeConfigFile({
      gateway: { ...f.healthy.config.gateway, mode: "local", port },
    });
    expect(f.entry()?.lastKnownGood?.hash).toBe(hashConfigRaw(f.healthy.raw));
    expect(f.entry()?.lastObservedSuspiciousSignature).toBe(
      result.persistedHash + ":inherited-config-anomaly",
    );
    const written = await io.readConfigFileSnapshot();
    observeConfigSnapshotSync(f.deps, written);
    expect(await f.promote(written)).toBe(false);
  }
  expect(fs.readFileSync(f.configPath + ".last-good", "utf8")).toBe(f.healthy.raw);
});

it("does not classify a metadata-less reseed as suspicious", async () => {
  const f = fixture();
  const withMeta = f.snapshot({ ...f.healthy.config, meta: { lastTouchedVersion: "2026.9.37" } });
  await f.promote(withMeta);
  const reseed = f.snapshot(f.healthy.config);
  expect(await f.promote(reseed)).toBe(true);
  expect(fs.readFileSync(f.configPath + ".last-good", "utf8")).toBe(reseed.raw);
});

it("refuses a source changed after promotion preparation", async () => {
  const f = fixture();
  await f.promote(f.healthy);
  const before = fs.readFileSync(f.configPath + ".last-good", "utf8");
  const stat = f.deps.fs.promises.stat;
  vi.spyOn(f.deps.fs.promises, "stat").mockImplementation(
    new Proxy(stat, {
      async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        if (args[0] === f.configPath) {
          fs.writeFileSync(f.configPath, JSON.stringify({ gateway: { mode: "remote" } }));
        }
        return result;
      },
    }),
  );
  await expect(f.promote(f.healthy)).rejects.toThrow("source changed");
  expect(fs.readFileSync(f.configPath + ".last-good", "utf8")).toBe(before);
});

it.each(["conflict", "superseded", "unavailable"] as const)(
  "retries only definite health outcomes: %s",
  async (status) => {
    const f = fixture();
    await f.promote(f.healthy);
    const capture = await captureConfigHealthBaselineForWrite(f.deps, f.configPath);
    const small = f.snapshot({ gateway: { mode: "local" } });
    const original = capture!.store.captureContinuation.bind(capture!.store);
    let updates = 0;
    vi.spyOn(capture!.store, "captureContinuation").mockImplementation((mode) => {
      const store = original(mode);
      return {
        ...store,
        updateAfterFileCommit: async (...args) => {
          updates += 1;
          return updates === 1 ? { status } : store.updateAfterFileCommit(...args);
        },
      };
    });
    const compensation = await advanceConfigHealthBaselineForAcceptedWrite(f.deps, capture, {
      sourceSnapshot: f.healthy,
      raw: small.raw!,
      parsed: small.parsed,
      resolved: small.resolved,
    });
    expect(updates).toBe(status === "unavailable" ? 1 : 2);
    expect(compensation === null).toBe(status === "unavailable");
    expect(f.entry()?.lastKnownGood?.hash).toBe(
      hashConfigRaw(status === "unavailable" ? f.healthy.raw : small.raw),
    );
  },
);

it.each(["none", "new-baseline", "same-candidate", "marker-only"] as const)(
  "rollback restores its baseline and preserves newer health decisions: %s",
  async (newer) => {
    const f = fixture();
    await f.promote(f.healthy);
    const capture = await captureConfigHealthBaselineForWrite(f.deps, f.configPath);
    const small = f.snapshot({ gateway: { mode: "local" } });
    const compensation = await advanceConfigHealthBaselineForAcceptedWrite(f.deps, capture, {
      sourceSnapshot: f.healthy,
      raw: small.raw!,
      parsed: small.parsed,
      resolved: small.resolved,
    });
    expect(compensation).not.toBeNull();
    if (newer === "new-baseline") {
      healthOwner.patchConfigHealthEntryToStore(f.deps, f.configPath, {
        lastKnownGood: createConfigHealthFingerprint({
          raw: "{newer:true}",
          parsed: {},
          stat: null,
        }),
        lastObservedSuspiciousSignature: "newer-independent-marker",
      });
    }
    if (newer === "same-candidate") {
      healthOwner.patchConfigHealthEntryToStore(f.deps, f.configPath, {
        lastKnownGood: { ...f.entry()!.lastKnownGood!, observedAt: "2099-01-01T00:00:00.000Z" },
      });
    }
    if (newer === "marker-only") {
      healthOwner.patchConfigHealthEntryToStore(f.deps, f.configPath, {
        lastObservedSuspiciousSignature: "newer-independent-marker",
      });
    }
    const before = f.entry();
    fs.writeFileSync(f.configPath, f.healthy.raw!);
    await restoreConfigHealthBaselineForRolledBackWrite(f.deps, compensation);
    expect(f.entry()?.lastKnownGood?.hash).toBe(
      newer === "new-baseline" || newer === "same-candidate"
        ? before?.lastKnownGood?.hash
        : hashConfigRaw(f.healthy.raw),
    );
    if (newer === "new-baseline" || newer === "same-candidate") {
      expect(f.entry()).toEqual(before);
    }
    if (newer === "marker-only") {
      expect(f.entry()?.lastObservedSuspiciousSignature).toBe("newer-independent-marker");
    }
  },
);

it("retains the captured database for replacement observations and refuses retirement", async () => {
  const f = fixture();
  await f.promote(f.healthy);
  const capture = await captureConfigHealthBaselineForWrite(f.deps, f.configPath);
  f.deps.env.OPENCLAW_STATE_DIR = dirs.make("other-config-db-");
  const small = f.snapshot({ gateway: { mode: "local" } });
  const result = await advanceConfigHealthBaselineForAcceptedWrite(f.deps, capture, {
    sourceSnapshot: f.healthy,
    raw: small.raw!,
    parsed: small.parsed,
  });
  expect(result).not.toBeNull();
  expect(f.entry()).toBeUndefined();
  await closeOpenClawStateDatabaseAsync();
  expect(
    await advanceConfigHealthBaselineForAcceptedWrite(f.deps, capture, {
      sourceSnapshot: f.healthy,
      raw: small.raw!,
      parsed: small.parsed,
    }),
  ).toBeNull();
});

it("settles advancement superseded by an actual observed read", async () => {
  const f = fixture();
  await f.promote(f.healthy);
  const capture = await captureConfigHealthBaselineForWrite(f.deps, f.configPath);
  const small = f.snapshot({ gateway: { mode: "local", port: 19205 } });
  const original = capture!.store.captureContinuation.bind(capture!.store);
  let observed = false;
  vi.spyOn(capture!.store, "captureContinuation").mockImplementation((mode) => {
    const store = original(mode);
    return {
      ...store,
      updateAfterFileCommit: async (...args) => {
        if (!observed) {
          observed = true;
          observeConfigSnapshotSync(f.deps, small);
        }
        return store.updateAfterFileCommit(...args);
      },
    };
  });
  expect(
    await advanceConfigHealthBaselineForAcceptedWrite(f.deps, capture, {
      sourceSnapshot: f.healthy,
      raw: small.raw,
      parsed: small.parsed,
      resolved: small.resolved,
    }),
  ).not.toBeNull();
  expect(observed).toBe(true);
  expect(f.entry()?.lastKnownGood?.hash).toBe(hashConfigRaw(small.raw));
  expect(await f.promote(small)).toBe(true);
});

it("does not retry an unavailable baseline read", async () => {
  const f = fixture();
  await f.promote(f.healthy);
  const capture = healthOwner.captureConfigHealthStateStore;
  const read = vi.fn(async () => ({ state: {}, basis: null }));
  vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
    const owner = capture(...args);
    return {
      ...owner,
      captureContinuation: (mode) => ({ ...owner.captureContinuation(mode), read }),
    };
  });
  expect(await captureConfigHealthBaselineForWrite(f.deps, f.configPath)).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});

it("restores an inherited marker only when it still belongs to the rolled-back write", async () => {
  const f = fixture();
  await f.promote(f.healthy);
  const truncated = f.snapshot({ gateway: { mode: "local" } });
  const capture = await captureConfigHealthBaselineForWrite(f.deps, f.configPath);
  const candidate = f.snapshot({
    ...f.healthy.config,
    gateway: { ...f.healthy.config.gateway, port: 19207 },
  });
  const compensation = await advanceConfigHealthBaselineForAcceptedWrite(f.deps, capture, {
    sourceSnapshot: truncated,
    raw: candidate.raw,
    parsed: candidate.parsed,
    resolved: candidate.resolved,
  });
  expect(f.entry()?.lastObservedSuspiciousSignature).toBe(
    hashConfigRaw(candidate.raw) + ":inherited-config-anomaly",
  );
  fs.writeFileSync(f.configPath, truncated.raw);
  await restoreConfigHealthBaselineForRolledBackWrite(f.deps, compensation);
  expect(f.entry()?.lastObservedSuspiciousSignature).toBeNull();
  expect(f.entry()?.lastKnownGood?.hash).toBe(hashConfigRaw(f.healthy.raw));
});

it("restores the pre-write baseline when an intervening read records the published candidate", async () => {
  const f = fixture();
  const originalRaw = f.healthy.raw;
  const observationTime = "2026-11-09T16:00:01.000Z";
  const advancementTime = "2026-11-09T16:00:02.000Z";
  let clock = "2026-11-09T16:00:00.000Z";
  vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => clock);
  expect(await f.promote(f.healthy)).toBe(true);
  const baselineBefore = f.entry();
  const grownConfig: OpenClawConfig = {
    gateway: {
      mode: "local",
      trustedProxies: Array.from({ length: 400 }, (_, i) => "192.0.2." + i),
    },
  };
  expect(Buffer.byteLength(JSON.stringify(grownConfig, null, 2))).toBeGreaterThan(
    Buffer.byteLength(originalRaw) * 2,
  );
  let observedCandidateHash: string | undefined;
  let observedCandidateTime: string | undefined;
  let activationBaselineTime: string | undefined;
  const failure = new Error("synthetic overlay failure");
  await withEnvAsync(
    createPathResolutionEnv(f.deps.env.HOME!, {
      ...f.deps.env,
      OPENCLAW_CONFIG_PATH: f.configPath,
    }),
    async () => {
      const unsubscribe = registerConfigWriteListener(vi.fn(), {
        ownsRuntimeActivationFor: f.configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          reapplyRuntimeOverlays() {
            activationBaselineTime = f.entry()?.lastKnownGood?.observedAt;
            throw failure;
          },
          reapplyCompareOverlays: (config) => config,
        }),
      });
      try {
        setRuntimeConfigSnapshot(f.healthy.config, f.healthy.config);
        await expect(
          writeConfigFile(grownConfig, {
            observe: false,
            assertConfigPathForWrite: () => {
              const raw = fs.readFileSync(f.configPath, "utf8");
              if (observedCandidateHash || raw === originalRaw) {
                return;
              }
              observedCandidateHash = hashConfigRaw(raw);
              clock = observationTime;
              const parsed: OpenClawConfig = JSON.parse(raw);
              observeConfigSnapshotSync(f.deps, {
                ...f.healthy,
                raw,
                parsed,
                sourceConfig: parsed,
                resolved: parsed,
                config: parsed,
                runtimeConfig: parsed,
              });
              observedCandidateTime = f.entry()?.lastKnownGood?.observedAt;
              // The writer constructs a different fingerprint timestamp after this read.
              clock = advancementTime;
            },
          }),
        ).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
          cause: failure,
        });
      } finally {
        unsubscribe();
        resetConfigRuntimeState();
      }
    },
  );
  expect(observedCandidateHash).toBeDefined();
  expect(observedCandidateHash).not.toBe(hashConfigRaw(originalRaw));
  expect(observedCandidateTime).toBe(observationTime);
  expect(activationBaselineTime).toBe(observationTime);
  expect(clock).toBe(advancementTime);
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(originalRaw);
  expect(f.entry()).toEqual(baselineBefore);
  const io = createConfigIO({ ...f.deps, configPath: f.configPath, observe: false });
  expect(await f.promote(await io.readConfigFileSnapshot())).toBe(true);
  expect(fs.readFileSync(f.configPath + ".last-good", "utf8")).toBe(originalRaw);
});
