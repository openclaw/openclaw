import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadPluginInstallRecords,
  loadPluginInstallRecordsSync,
  PLUGIN_INSTALL_LEDGER_WARNING,
  readPersistedPluginInstallLedger,
  recordPluginInstallInRecords,
  removePluginInstallRecordFromRecords,
  resolvePluginInstallLedgerStorePath,
  withoutPluginInstallRecords,
  writePersistedPluginInstallLedger,
} from "./install-ledger-store.js";

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin install ledger store", () => {
  it("writes machine-managed install records outside config", async () => {
    const stateDir = makeStateDir();

    await writePersistedPluginInstallLedger(
      {
        twitch: {
          source: "npm",
          spec: "@openclaw/plugin-twitch@1.0.0",
          installPath: "plugins/npm/@openclaw/plugin-twitch",
        },
      },
      {
        stateDir,
        now: () => new Date(1777118400000),
      },
    );

    const ledgerPath = resolvePluginInstallLedgerStorePath({ stateDir });
    expect(ledgerPath).toBe(path.join(stateDir, "plugins", "installs.json"));
    expect(JSON.parse(fs.readFileSync(ledgerPath, "utf8"))).toEqual({
      version: 1,
      warning: PLUGIN_INSTALL_LEDGER_WARNING,
      updatedAtMs: 1777118400000,
      records: {
        twitch: {
          source: "npm",
          spec: "@openclaw/plugin-twitch@1.0.0",
          installPath: "plugins/npm/@openclaw/plugin-twitch",
        },
      },
    });
  });

  it("prefers persisted records over legacy config installs", async () => {
    const stateDir = makeStateDir();
    await writePersistedPluginInstallLedger(
      {
        persisted: {
          source: "npm",
          spec: "persisted@1.0.0",
        },
      },
      { stateDir },
    );

    await expect(
      loadPluginInstallRecords({
        stateDir,
        config: {
          plugins: {
            installs: {
              legacy: {
                source: "npm",
                spec: "legacy@1.0.0",
              },
            },
          },
        },
      }),
    ).resolves.toEqual({
      persisted: {
        source: "npm",
        spec: "persisted@1.0.0",
      },
    });
  });

  it("falls back to legacy config installs when no ledger exists", () => {
    const stateDir = makeStateDir();

    expect(
      loadPluginInstallRecordsSync({
        stateDir,
        config: {
          plugins: {
            installs: {
              legacy: {
                source: "path",
                sourcePath: "./plugins/legacy",
              },
            },
          },
        },
      }),
    ).toEqual({
      legacy: {
        source: "path",
        sourcePath: "./plugins/legacy",
      },
    });
  });

  it("updates and removes records without mutating caller state", async () => {
    const records: Record<string, PluginInstallRecord> = {
      keep: {
        source: "npm",
        spec: "keep@1.0.0",
      },
    } satisfies Record<string, PluginInstallRecord>;
    const withInstall = recordPluginInstallInRecords(records, {
      pluginId: "demo",
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(records).toEqual({
      keep: {
        source: "npm",
        spec: "keep@1.0.0",
      },
    });
    expect(withInstall.demo).toMatchObject({
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(removePluginInstallRecordFromRecords(withInstall, "demo")).toEqual(records);
  });

  it("strips legacy installs from config writes", () => {
    expect(
      withoutPluginInstallRecords({
        plugins: {
          entries: {
            twitch: { enabled: true },
          },
          installs: {
            twitch: { source: "npm", spec: "twitch@1.0.0" },
          },
        },
      }),
    ).toEqual({
      plugins: {
        entries: {
          twitch: { enabled: true },
        },
      },
    });
  });

  it("ignores invalid persisted ledgers and falls back to config", async () => {
    const stateDir = makeStateDir();
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      resolvePluginInstallLedgerStorePath({ stateDir }),
      JSON.stringify({ version: 999, records: {} }),
    );

    await expect(readPersistedPluginInstallLedger({ stateDir })).resolves.toBeNull();
    await expect(
      loadPluginInstallRecords({
        stateDir,
        config: {
          plugins: {
            installs: {
              legacy: { source: "npm", spec: "legacy@1.0.0" },
            },
          },
        },
      }),
    ).resolves.toEqual({
      legacy: { source: "npm", spec: "legacy@1.0.0" },
    });
  });
});
