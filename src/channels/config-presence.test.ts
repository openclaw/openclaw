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
  listPotentialConfiguredChannelIds,
} from "./config-presence.js";
import * as persistedAuthState from "./plugins/persisted-auth-state.js";

const tempDirs: string[] = [];

const configAndEnvOnly = { includePersistedAuthState: false };

beforeEach(() => {
  vi.spyOn(persistedAuthState, "listBundledChannelIdsWithPersistedAuthState").mockReturnValue([
    "matrix",
  ]);
  vi.spyOn(persistedAuthState, "hasBundledChannelPersistedAuthState").mockImplementation(
    ({ channelId, env }) =>
      channelId === "matrix" && Boolean(env?.OPENCLAW_STATE_DIR?.includes("persisted-matrix")),
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

  it("ignores enabled-only matrix config when listing configured channels", () => {
    const env = {} as NodeJS.ProcessEnv;
    const cfg = { channels: { matrix: { enabled: false } } };

    expect(listPotentialConfiguredChannelIds(cfg, env, configAndEnvOnly)).toEqual([]);
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

  it("detects env-only channel config", () => {
    const env = {
      MATRIX_ACCESS_TOKEN: "token",
    } as NodeJS.ProcessEnv;

    expect(listPotentialConfiguredChannelIds({}, env, configAndEnvOnly)).toEqual(["matrix"]);
    expect(listPotentialConfiguredChannelPresenceSignals({}, env, configAndEnvOnly)).toEqual([
      { channelId: "matrix", source: "env" },
    ]);
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
    { channelIds: undefined, expectedIds: ["matrix"] },
    { channelIds: ["matrix"], expectedIds: ["matrix"] },
    { channelIds: ["whatsapp"], expectedIds: [] },
    { channelIds: [], expectedIds: [] },
  ])(
    "scopes persisted credentials without hiding env signals: $channelIds",
    ({ channelIds, expectedIds }) => {
      const stateDir = makeTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir, MATTERMOST_BOT_TOKEN: "test-token" };

      expect(
        listPotentialConfiguredChannelIds({}, env, {
          persistedAuthChannelIds: channelIds && new Set(channelIds),
        }),
      ).toEqual(["mattermost", ...expectedIds]);
    },
  );
});
