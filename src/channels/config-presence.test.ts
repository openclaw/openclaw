import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isChannelConfigMetadataKey } from "./config-metadata.js";
import {
  hasMeaningfulChannelConfig,
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals,
  listPotentialConfiguredChannelPresenceSignalsAsync,
  listPotentialConfiguredChannelIds,
} from "./config-presence.js";
import * as packageState from "./plugins/package-state-probes.js";

const tempDirs: string[] = [];

const configAndEnvOnly = { includePersistedAuthState: false };

beforeEach(() => {
  vi.spyOn(packageState, "listBundledChannelIdsForPackageState").mockImplementation(
    (metadataKey) => (metadataKey === "persistedAuthState" ? ["matrix"] : []),
  );
  vi.spyOn(packageState, "hasBundledChannelPackageState").mockImplementation(
    ({ metadataKey, channelId, env }) =>
      metadataKey === "persistedAuthState" &&
      channelId === "matrix" &&
      Boolean(env?.OPENCLAW_STATE_DIR?.includes("persisted-matrix")),
  );
  vi.spyOn(packageState, "hasBundledChannelPackageStateAsync").mockImplementation(
    async ({ metadataKey, channelId, env }) =>
      metadataKey === "persistedAuthState" &&
      channelId === "matrix" &&
      Boolean(env?.OPENCLAW_STATE_DIR?.includes("persisted-matrix")),
  );
});

function makeTempStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-matrix-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("config presence", () => {
  it("treats enabled-only channel sections as not meaningfully configured", () => {
    expect(hasMeaningfulChannelConfig({ enabled: false })).toBe(false);
    expect(hasMeaningfulChannelConfig({ enabled: true })).toBe(false);
    expect(hasMeaningfulChannelConfig({})).toBe(false);
    expect(hasMeaningfulChannelConfig({ homeserver: "https://matrix.example.org" })).toBe(true);
  });

  it("excludes metadata and blank keys while trimming configured channel ids", () => {
    const cfg = {
      channels: {
        defaults: { token: "test-token" },
        modelByChannel: { discord: "openai/gpt-5.6-luna" },
        "  ": { token: "dummy" },
        " matrix ": { homeserver: "https://matrix.example.org" },
      },
    } as unknown as OpenClawConfig;

    expect(isChannelConfigMetadataKey(" modelByChannel ")).toBe(true);
    expect(listPotentialConfiguredChannelIds(cfg, {}, configAndEnvOnly)).toEqual(["matrix"]);
  });

  it("lists explicitly disabled channel ids case-insensitively", () => {
    const cfg = {
      channels: {
        Matrix: { enabled: false },
        telegram: { enabled: true },
        slack: { botToken: "token" },
        discord: false,
        modelByChannel: { enabled: false },
        " ": { enabled: false },
      },
    } as unknown as OpenClawConfig;

    expect(listExplicitlyDisabledChannelIdsForConfig(cfg)).toEqual(["matrix"]);
  });

  it("detects official external channel env vars", () => {
    const env = {
      MATTERMOST_URL: "https://mattermost.example.test",
      MATTERMOST_BOT_TOKEN: "token",
    } as NodeJS.ProcessEnv;

    expect(listPotentialConfiguredChannelIds({}, env, configAndEnvOnly)).toEqual(["mattermost"]);
    expect(listPotentialConfiguredChannelPresenceSignals({}, env, configAndEnvOnly)).toEqual([
      { channelId: "mattermost", source: "env" },
    ]);
  });

  it.each([
    { channelIds: ["matrix"], expectedIds: ["matrix"] },

    { channelIds: [], expectedIds: [] },
  ])(
    "scopes persisted credentials without hiding env signals: $channelIds",
    async ({ channelIds, expectedIds }) => {
      const stateDir = makeTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir, MATTERMOST_BOT_TOKEN: "test-token" };

      expect(
        listPotentialConfiguredChannelIds({}, env, {
          persistedAuthChannelIds: channelIds && new Set(channelIds),
        }),
      ).toEqual(["mattermost", ...expectedIds]);
      vi.mocked(packageState.hasBundledChannelPackageState).mockImplementation(() => {
        throw new Error("runtime discovery must not invoke the synchronous checker");
      });
      const signals = await listPotentialConfiguredChannelPresenceSignalsAsync({}, env, {
        persistedAuthChannelIds: channelIds && new Set(channelIds),
      });
      expect(signals.map((signal) => signal.channelId)).toEqual(["mattermost", ...expectedIds]);
    },
  );
});
