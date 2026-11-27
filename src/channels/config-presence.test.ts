import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import * as channelCatalog from "../plugins/channel-catalog-registry.js";
import * as externalCatalog from "../plugins/official-external-plugin-catalog.js";
import { isChannelConfigMetadataKey } from "./config-metadata.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals as presence,
  listPotentialConfiguredChannelPresenceSignalsAsync as presenceAsync,
  listPotentialConfiguredChannelIds as channelIds,
} from "./config-presence.js";
import * as state from "./plugins/package-state-probes.js";

const tempDirs: string[] = [];
const configAndEnvOnly = { includePersistedAuthState: false };
const configured = (channels: Record<string, unknown>) => ({ channels }) as OpenClawConfig;
const persistedEnv = () => ({
  OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "persisted-matrix-"),
  MATTERMOST_BOT_TOKEN: "test-token",
});

beforeEach(() => {
  vi.spyOn(state, "listBundledChannelIdsForPackageState").mockImplementation((metadataKey) =>
    metadataKey === "persistedAuthState" ? ["matrix"] : [],
  );
  const hasState: typeof state.hasBundledChannelPackageState = (params) =>
    params.metadataKey === "persistedAuthState" &&
    params.channelId === "matrix" &&
    Boolean(params.env?.OPENCLAW_STATE_DIR?.includes("persisted-matrix"));
  vi.spyOn(state, "hasBundledChannelPackageState").mockImplementation(hasState);
  vi.spyOn(state, "hasBundledChannelPackageStateAsync").mockImplementation(async (p) =>
    hasState(p),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs(tempDirs);
});

it("excludes metadata and blank keys while trimming configured channel ids", () => {
  const cfg = configured({
    defaults: { token: "test-token" },
    modelByChannel: { discord: "openai/gpt-5.6-luna" },
    "  ": { token: "dummy" },
    " matrix ": { homeserver: "https://matrix.example.org" },
    disabled: { enabled: false },
    enabled: { enabled: true },
    empty: {},
  });
  expect(isChannelConfigMetadataKey(" modelByChannel ")).toBe(true);
  expect(channelIds(cfg, {}, configAndEnvOnly)).toEqual(["matrix"]);
});

it("lists explicitly disabled channel ids case-insensitively", () => {
  const cfg = configured({
    Matrix: { enabled: false },
    telegram: { enabled: true },
    slack: { botToken: "token" },
    discord: false,
    modelByChannel: { enabled: false },
    " ": { enabled: false },
  });
  expect(listExplicitlyDisabledChannelIdsForConfig(cfg)).toEqual(["matrix"]);
});

it("detects official external channel env vars", () => {
  const env = { MATTERMOST_URL: "https://mattermost.example.test", MATTERMOST_BOT_TOKEN: "token" };

  expect(channelIds({}, env, configAndEnvOnly)).toEqual(["mattermost"]);
  expect(presence({}, env, configAndEnvOnly)).toEqual([{ channelId: "mattermost", source: "env" }]);
});

it.each([false, true])("suppresses ambient discovery (auth: %s)", async (includeAuth) => {
  const catalog = vi.spyOn(channelCatalog, "listChannelCatalogEntries");
  const externalEnv = vi.spyOn(externalCatalog, "listOfficialExternalChannelEnvVars");
  const cfg = { channels: { slack: { botToken: "synthetic-token" } } };
  const env = persistedEnv();
  const options = {
    ambientEnvTriggers: "suppress" as const,
    includePersistedAuthState: includeAuth,
  };
  const expected = [
    { channelId: "slack", source: "config" },
    ...(includeAuth ? [{ channelId: "matrix", source: "persisted-auth" }] : []),
  ];

  expect(presence(cfg, env, options)).toEqual(expected);
  expect(await presenceAsync(cfg, env, options)).toEqual(expected);
  expect(catalog).not.toHaveBeenCalled();
  expect(externalEnv).not.toHaveBeenCalled();
});

it.each([{ ids: ["matrix"] }, { ids: [] }])("scopes auth: $ids", async ({ ids }) => {
  const env = persistedEnv();
  const options = { persistedAuthChannelIds: new Set(ids) };
  const expected = ["mattermost", ...ids];

  expect(channelIds({}, env, options)).toEqual(expected);
  vi.mocked(state.hasBundledChannelPackageState).mockImplementation(() => {
    throw new Error("runtime discovery must not invoke the synchronous checker");
  });
  const signals = await presenceAsync({}, env, options);
  expect(signals.map((signal) => signal.channelId)).toEqual(expected);
});
