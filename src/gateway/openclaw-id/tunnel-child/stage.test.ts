import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discardStagedEndpointKey, stageEndpointKey, tunnelKeyPath } from "../tunnel-runtime.js";
import { createKeyFile, ed25519PublicKeyHex, stagedKeyPath } from "./keyfile.js";

// The re-bind's one-shot tunnel child: it stages K_srv' so the Gateway never reads the key file.
let stateDir: string;
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function setup() {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-stage-"));
  const current = createKeyFile(tunnelKeyPath(stateDir));
  return { staged: stagedKeyPath(tunnelKeyPath(stateDir)), current };
}

describe("staging the next endpoint key", () => {
  it("creates a private staged key once, reuses it and leaves the current key alone", async () => {
    const { staged, current } = setup();
    const first = await stageEndpointKey(stateDir);
    expect(first).toBe(`iroh:${ed25519PublicKeyHex(fs.readFileSync(staged))}`);
    expect(fs.statSync(staged).mode & 0o077).toBe(0);
    expect(await stageEndpointKey(stateDir)).toBe(first);
    expect(fs.readFileSync(tunnelKeyPath(stateDir))).toEqual(current);
  }, 30_000);

  it("discards a staged key unless the binding names it", async () => {
    const { staged } = setup();
    const bound = await stageEndpointKey(stateDir);
    // A committed re-bind that was not promoted yet keeps its key.
    await discardStagedEndpointKey(stateDir, bound);
    expect(fs.existsSync(staged)).toBe(true);
    await discardStagedEndpointKey(stateDir, `iroh:${"ab".repeat(32)}`);
    expect(fs.existsSync(staged)).toBe(false);
  }, 30_000);
});
