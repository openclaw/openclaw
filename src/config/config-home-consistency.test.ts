import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfigPath } from "./paths.js";
import { resolveStateDir } from "./state-dir.js";

/**
 * Consistency between the two config-home resolution layers.
 *
 * Both layers read overlapping environment variables but at different
 * precedence. They must agree on the same state directory for every
 * combination of OPENCLAW_HOME, OPENCLAW_STATE_DIR and
 * OPENCLAW_CONFIG_PATH, because different subsystems call different
 * resolvers: a CLI process writing via one and a gateway reading via the
 * other would otherwise target two different openclaw.json files with no
 * error on either side.
 */

const ORIGINAL_ENV = { ...process.env };

let sandbox: string | undefined;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-home-consistency-"));
  process.env.HOME = sandbox;
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
});

afterEach(() => {
  for (const key of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const) {
    delete process.env[key];
  }
  if (sandbox) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

describe("config home consistency", () => {
  it("OPENCLAW_HOME moves both resolvers to the same state dir", () => {
    const home = path.join(sandbox!, "alt-home");
    process.env.OPENCLAW_HOME = home;

    const state = resolveStateDir();
    const config = resolveConfigPath();

    expect(state).toBe(path.join(home, ".openclaw"));
    expect(config).toBe(path.join(state, "openclaw.json"));
  });

  it("OPENCLAW_STATE_DIR pins both resolvers to the same directory", () => {
    const stateDir = path.join(sandbox!, "custom-state");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    expect(resolveStateDir()).toBe(stateDir);
    expect(resolveConfigPath()).toBe(path.join(stateDir, "openclaw.json"));
  });

  it("a relative OPENCLAW_STATE_DIR resolves to an absolute, agreed directory", () => {
    // The incident this suite was written for: a CLI invoked with a config
    // override must not write a second, orphaned openclaw.json that the
    // gateway never reads.
    process.env.OPENCLAW_STATE_DIR = "relative-state";

    const state = resolveStateDir();
    const config = resolveConfigPath();

    expect(path.isAbsolute(state)).toBe(true);
    expect(config).toBe(path.join(state, "openclaw.json"));
  });

  it("resolvers agree when the config already exists under the state dir", () => {
    const stateDir = path.join(sandbox!, "existing-state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    expect(resolveStateDir()).toBe(stateDir);
    expect(resolveConfigPath()).toBe(path.join(stateDir, "openclaw.json"));
  });
});
