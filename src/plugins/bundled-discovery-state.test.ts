// Covers memoized bundled-discovery mode reads across machine-state writes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  clearBundledDiscoveryModeMemo,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";

const roots: string[] = [];
let snapshot: ReturnType<typeof captureEnv>;
async function createRoot() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-discovery-")),
  );
  roots.push(root);
  return root;
}

describe("readBundledDiscoveryModeMemoized", () => {
  beforeEach(() => {
    snapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });
  afterEach(async () => {
    snapshot.restore();
    for (const root of roots.splice(0)) {
      await removeBundledDiscoveryStateRoot(root);
    }
    clearBundledDiscoveryModeMemo();
  });

  it("observes a machine-state write after the memo is cleared", async () => {
    const stateDir = await createRoot();
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    clearBundledDiscoveryModeMemo();
    expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
    writeConfigMachineState("plugins.bundledDiscovery", "compat");
    // Doctor must clear the pre-migration memo before rebuilding indexes.
    expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
    clearBundledDiscoveryModeMemo();
    expect(readBundledDiscoveryModeMemoized()).toBe("compat");
  });

  it("does not leak one state root's cached mode into an interleaved scope", async () => {
    const compatRoot = await createRoot();
    const plainRoot = await createRoot();
    setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
    writeConfigMachineState("plugins.bundledDiscovery", "compat");
    clearBundledDiscoveryModeMemo();
    expect(readBundledDiscoveryModeMemoized()).toBe("compat");

    setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
    expect(readBundledDiscoveryModeMemoized()).toBeUndefined();

    setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
    expect(readBundledDiscoveryModeMemoized()).toBe("compat");
  });

  it("honors a caller-supplied env's state root over the process root", async () => {
    // #123416: explicit caller roots must not inherit the process root's mode.
    const compatRoot = await createRoot();
    const plainRoot = await createRoot();
    setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
    writeConfigMachineState("plugins.bundledDiscovery", "compat");
    setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
    clearBundledDiscoveryModeMemo();

    const callerEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
    expect(readBundledDiscoveryModeMemoized(callerEnv)).toBe("compat");
    expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
    expect(readBundledDiscoveryModeMemoized(callerEnv)).toBe("compat");
  });
});
