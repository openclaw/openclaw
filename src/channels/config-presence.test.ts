import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasMeaningfulChannelConfig,
  hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelIds,
} from "./config-presence.js";

const tempDirs: string[] = [];

function makeTempStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-config-presence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config presence", () => {
  it("treats enabled-only channel sections as not meaningfully configured", () => {
    expect(hasMeaningfulChannelConfig({ enabled: false })).toBe(false);
    expect(hasMeaningfulChannelConfig({ enabled: true })).toBe(false);
    expect(hasMeaningfulChannelConfig({})).toBe(false);
    expect(hasMeaningfulChannelConfig({ homeserver: "https://matrix.example.org" })).toBe(true);
  });

  it("ignores enabled-only matrix config when listing configured channels", () => {
    const stateDir = makeTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    const cfg = { channels: { matrix: { enabled: false } } };

    expect(listPotentialConfiguredChannelIds(cfg, env)).toEqual([]);
    expect(hasPotentialConfiguredChannels(cfg, env)).toBe(false);
  });
});
