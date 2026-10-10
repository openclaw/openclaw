// Covers memoized bundled-discovery mode reads across machine-state writes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

describe("readBundledDiscoveryModeMemoized", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("clears prepared facts in an inactive operation cache", async () => {
    const env = { OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "plugin-mode-cache") };
    await using cache = createPluginCache();
    await withPluginCache(cache, () =>
      prepareBundledDiscoveryMode(env, async () => ({ value_json: '"compat"' })),
    );

    clearBundledDiscoveryModeMemo();

    expect(
      withPluginCache(cache, () => readBundledDiscoveryModeMemoized(env, {}, () => "allowlist")),
    ).toBe("allowlist");
    await withPluginCache(cache, async () => {
      await prepareBundledDiscoveryMode(env, async () => ({ value_json: '"allowlist"' }));
      expect(readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
    });
  });

  it("observes a machine-state write after the memo is cleared", async () => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-discovery-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    try {
      clearBundledDiscoveryModeMemo();
      // Pre-migration read caches the absent mode.
      expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      // Regression for the doctor same-process staleness: the memo must not
      // outlive the write, or index rebuilds keep strict-gate decisions.
      expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
      clearBundledDiscoveryModeMemo();
      expect(readBundledDiscoveryModeMemoized()).toBe("compat");
    } finally {
      envSnapshot.restore();
      await removeBundledDiscoveryStateRoot(stateDir);
    }
  });

  it("does not leak one state root's cached mode into an interleaved scope", async () => {
    // The memo is keyed by the resolved state-database path: isolated scopes
    // (agent execution, doctor lint) alternating in one process must each see
    // their own root's mode without explicit clears.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bd-compat-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bd-plain-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      clearBundledDiscoveryModeMemo();
      expect(readBundledDiscoveryModeMemoized()).toBe("compat");

      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      expect(readBundledDiscoveryModeMemoized()).toBeUndefined();

      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      expect(readBundledDiscoveryModeMemoized()).toBe("compat");
    } finally {
      envSnapshot.restore();
      await removeBundledDiscoveryStateRoot(compatRoot);
      await removeBundledDiscoveryStateRoot(plainRoot);
    }
  });

  it("honors a caller-supplied env's state root over the process root", async () => {
    // Two-root regression (#123416 review): provider and manifest-contract
    // registry loads pass an explicit env; compat recorded in that env's root
    // must be readable even when the process root has no mode, and the
    // process-root read must stay strict.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bd-caller-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bd-process-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      // Process root has no recorded mode.
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const callerEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
      expect(readBundledDiscoveryModeMemoized(callerEnv)).toBe("compat");
      expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
      // Alternating scopes stay correct: the memo re-keys per resolved root.
      expect(readBundledDiscoveryModeMemoized(callerEnv)).toBe("compat");
    } finally {
      envSnapshot.restore();
      await removeBundledDiscoveryStateRoot(compatRoot);
      await removeBundledDiscoveryStateRoot(plainRoot);
    }
  });
});
