// Config presence tests cover channel config detection and missing-config diagnostics.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  hasMeaningfulChannelConfig,
  invalidatePersistedAuthStateCache,
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals,
  listPotentialConfiguredChannelIds,
} from "./config-presence.js";

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: vi.fn(() => ["matrix"]),
  hasBundledChannelPersistedAuthState: vi.fn(() => true),
}));

import { listBundledChannelIdsWithPersistedAuthState } from "../channels/plugins/persisted-auth-state.js";

const tempDirs: string[] = [];

const matrixPresenceOptions = {
  channelIds: ["matrix"],
  persistedAuthStateProbe: {
    listChannelIds: () => ["matrix"],
    hasState: ({ channelId, env }: { channelId: string; env?: NodeJS.ProcessEnv }) =>
      channelId === "matrix" && Boolean(env?.OPENCLAW_STATE_DIR?.includes("persisted-matrix")),
  },
};

function makeTempStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-config-presence-"));
  tempDirs.push(dir);
  return dir;
}

function expectPotentialConfiguredChannelCase(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  expectedIds: string[];
  options?: Parameters<typeof listPotentialConfiguredChannelIds>[2];
}) {
  const options = params.options ?? matrixPresenceOptions;
  expect(listPotentialConfiguredChannelIds(params.cfg, params.env, options)).toEqual(
    params.expectedIds,
  );
}

afterEach(() => {
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

  it("ignores enabled-only matrix config when listing configured channels", () => {
    const env = {} as NodeJS.ProcessEnv;
    const cfg = { channels: { matrix: { enabled: false } } };

    expectPotentialConfiguredChannelCase({
      cfg,
      env,
      expectedIds: [],
      options: { includePersistedAuthState: false },
    });
  });

  it("lists explicitly disabled channel ids case-insensitively", () => {
    const cfg = {
      channels: {
        Matrix: { enabled: false },
        telegram: { enabled: true },
        slack: { botToken: "token" },
        discord: false,
      },
    } as unknown as OpenClawConfig;

    expect(listExplicitlyDisabledChannelIdsForConfig(cfg)).toEqual(["matrix"]);
  });

  it("detects env-only channel config", () => {
    const env = {
      MATRIX_ACCESS_TOKEN: "token",
    } as NodeJS.ProcessEnv;

    expectPotentialConfiguredChannelCase({
      cfg: {},
      env,
      expectedIds: ["matrix"],
      options: { includePersistedAuthState: false },
    });
    expect(
      listPotentialConfiguredChannelPresenceSignals({}, env, {
        includePersistedAuthState: false,
      }),
    ).toEqual([{ channelId: "matrix", source: "env" }]);
  });

  it("detects official external channel env vars", () => {
    const env = {
      MATTERMOST_URL: "https://mattermost.example.test",
      MATTERMOST_BOT_TOKEN: "token",
    } as NodeJS.ProcessEnv;

    expectPotentialConfiguredChannelCase({
      cfg: {},
      env,
      expectedIds: ["mattermost"],
      options: { includePersistedAuthState: false },
    });
    expect(
      listPotentialConfiguredChannelPresenceSignals({}, env, {
        includePersistedAuthState: false,
      }),
    ).toEqual([{ channelId: "mattermost", source: "env" }]);
  });

  it("detects persisted Matrix credentials without config or env", () => {
    const stateDir = makeTempStateDir().replace(
      "openclaw-channel-config-presence-",
      "persisted-matrix-",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    expectPotentialConfiguredChannelCase({
      cfg: {},
      env,
      expectedIds: ["matrix"],
      options: {
        persistedAuthStateProbe: {
          listChannelIds: () => ["matrix"],
          hasState: () => true,
        },
      },
    });
  });

  it("re-reads persisted-auth channel ids after registry mutation", () => {
    // Exercises the module-level cache in listPersistedAuthStateChannelIds, which
    // is bypassed by persistedAuthStateProbe (used elsewhere) but live for
    // doctor / non-discovery callers. A newly installed plugin can add a channel
    // with persisted auth state; without invalidation the stale cache hides it.
    const stateDir = makeTempStateDir().replace(
      "openclaw-channel-config-presence-",
      "persisted-matrix-",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    const options = { channelIds: ["matrix", "signal"] };
    const before = listPotentialConfiguredChannelIds({}, env, options);
    expect(before).toEqual(["matrix"]);

    // Registry now reports a second persisted-auth channel.
    vi.mocked(listBundledChannelIdsWithPersistedAuthState).mockReturnValue(["matrix", "signal"]);

    const stale = listPotentialConfiguredChannelIds({}, env, options);
    expect(stale).toEqual(["matrix"]);

    invalidatePersistedAuthStateCache();
    const after = listPotentialConfiguredChannelIds({}, env, options);
    expect(after).toEqual(["matrix", "signal"]);
  });

  it("handles plugin uninstallation reducing persisted-auth channels", () => {
    const stateDir = makeTempStateDir().replace(
      "openclaw-channel-config-presence-",
      "persisted-multi-",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    // Start with matrix and signal both available
    vi.mocked(listBundledChannelIdsWithPersistedAuthState).mockReturnValue(["matrix", "signal"]);
    invalidatePersistedAuthStateCache();

    const options = { channelIds: ["matrix", "signal"] };
    const before = listPotentialConfiguredChannelIds({}, env, options);
    expect(before).toEqual(["matrix", "signal"]);

    // Uninstall signal plugin - registry now reports only matrix
    vi.mocked(listBundledChannelIdsWithPersistedAuthState).mockReturnValue(["matrix"]);

    // Without cache invalidation, stale data still shows signal
    const stale = listPotentialConfiguredChannelIds({}, env, options);
    expect(stale).toEqual(["matrix", "signal"]);

    // After invalidation, only matrix is reported
    invalidatePersistedAuthStateCache();
    const after = listPotentialConfiguredChannelIds({}, env, options);
    expect(after).toEqual(["matrix"]);
  });

  it("handles multiple install/uninstall cycles", () => {
    const stateDir = makeTempStateDir().replace(
      "openclaw-channel-config-presence-",
      "persisted-cycles-",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    const options = { channelIds: ["matrix", "signal", "whatsapp"] };

    // Initial state: only matrix
    const initial = listPotentialConfiguredChannelIds({}, env, options);
    expect(initial).toEqual(["matrix"]);

    // Install signal
    vi.mocked(listBundledChannelIdsWithPersistedAuthState).mockReturnValue(["matrix", "signal"]);
    invalidatePersistedAuthStateCache();
    const afterInstall = listPotentialConfiguredChannelIds({}, env, options);
    expect(afterInstall).toEqual(["matrix", "signal"]);

    // Install whatsapp
    vi.mocked(listBundledChannelIdsWithPersistedAuthState).mockReturnValue([
      "matrix",
      "signal",
      "whatsapp",
    ]);
    invalidatePersistedAuthStateCache();
    const afterSecondInstall = listPotentialConfiguredChannelIds({}, env, options);
    expect(afterSecondInstall).toEqual(["matrix", "signal", "whatsapp"]);

    // Uninstall signal
    vi.mocked(listBundledChannelIdsWithPersistedAuthState).mockReturnValue(["matrix", "whatsapp"]);
    invalidatePersistedAuthStateCache();
    const afterUninstall = listPotentialConfiguredChannelIds({}, env, options);
    expect(afterUninstall).toEqual(["matrix", "whatsapp"]);
  });
});
