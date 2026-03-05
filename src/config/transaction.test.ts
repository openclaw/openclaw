import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  clearConfigCache,
  readConfigFileSnapshot,
  recoverConfigFromBackups,
  runConfigWriteTransaction,
} from "./config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

function makeSnapshot(
  overrides: Partial<ConfigFileSnapshot> & Pick<ConfigFileSnapshot, "path">,
): ConfigFileSnapshot {
  return {
    path: overrides.path,
    exists: overrides.exists ?? true,
    raw: "raw" in overrides ? (overrides.raw ?? null) : "{}\n",
    parsed: overrides.parsed ?? {},
    resolved: overrides.resolved ?? ({} as OpenClawConfig),
    valid: overrides.valid ?? true,
    config: overrides.config ?? ({} as OpenClawConfig),
    hash: overrides.hash,
    issues: overrides.issues ?? [],
    warnings: overrides.warnings ?? [],
    legacyIssues: overrides.legacyIssues ?? [],
  };
}

describe("config transactions", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-transaction-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withConfigCase<T>(params: {
    raw: string;
    run: (configPath: string) => Promise<T>;
  }): Promise<T> {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    const configPath = path.join(dir, "openclaw.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(configPath, params.raw, "utf-8");
    return await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_CONFIG_CACHE: "1",
      },
      async () => {
        clearConfigCache();
        return await params.run(configPath);
      },
    );
  }

  it("commits and verifies valid config updates", async () => {
    await withConfigCase({
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
      run: async () => {
        const result = await runConfigWriteTransaction({
          config: {
            gateway: { mode: "local", bind: "loopback" },
          },
        });
        expect(result.ok).toBe(true);
        expect(result.stage).toBeNull();
        expect(result.transactionId.length).toBeGreaterThan(0);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.bind).toBe("loopback");
      },
    });
  });

  it("rolls back committed writes when post-commit verification fails", async () => {
    await withConfigCase({
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
      run: async (configPath) => {
        const beforeRaw = await fs.readFile(configPath, "utf-8");
        const result = await runConfigWriteTransaction({
          config: {
            gateway: { mode: "local", bind: "loopback" },
          },
          verifyCommittedSnapshot: () => false,
          verificationErrorMessage: "forced verify failure",
        });
        expect(result.ok).toBe(false);
        expect(result.stage).toBe("verify");
        expect(result.rolledBack).toBe(true);
        expect(result.error).toBe("forced verify failure");

        const afterRaw = await fs.readFile(configPath, "utf-8");
        expect(afterRaw).toBe(beforeRaw);
      },
    });
  });

  it("recovers from the first valid backup when config is invalid", async () => {
    await withConfigCase({
      raw: "{invalid-json",
      run: async (configPath) => {
        await fs.writeFile(
          `${configPath}.bak`,
          '{\n  "gateway": { "mode": "local", "bind": "loopback" }\n}\n',
          "utf-8",
        );

        const result = await recoverConfigFromBackups();
        expect(result.recovered).toBe(true);
        expect(result.sourceBackupPath).toBe(`${configPath}.bak`);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.bind).toBe("loopback");
      },
    });
  });

  it("reports failure when no valid backups are available", async () => {
    await withConfigCase({
      raw: "{invalid-json",
      run: async (configPath) => {
        await fs.writeFile(`${configPath}.bak`, "{also-invalid", "utf-8");
        await fs.writeFile(`${configPath}.bak.1`, "{still-invalid", "utf-8");

        const result = await recoverConfigFromBackups();
        expect(result.recovered).toBe(false);
        expect(result.sourceBackupPath).toBeNull();
      },
    });
  });

  it("stops recovery after a successful restore write when restored config is still invalid", async () => {
    await withConfigCase({
      raw: "{invalid-json",
      run: async (configPath) => {
        const backupPath = `${configPath}.bak`;
        await fs.writeFile(backupPath, '{\n  "gateway": { "mode": "local" }\n}\n', "utf-8");
        const restoredIssues = [{ path: "gateway.bind", message: "invalid bind mode" }];

        const result = await recoverConfigFromBackups(
          {
            snapshot: makeSnapshot({
              path: configPath,
              exists: true,
              valid: false,
              raw: "{invalid-json",
              issues: [{ path: "<root>", message: "parse failed" }],
            }),
          },
          {
            createConfigIO: ((options: { configPath?: string }) => ({
              readConfigFileSnapshot: async () => {
                if (options.configPath === configPath) {
                  return makeSnapshot({
                    path: configPath,
                    exists: true,
                    valid: false,
                    raw: '{ "gateway": { "bind": "broken" } }',
                    issues: restoredIssues,
                  });
                }
                return makeSnapshot({
                  path: options.configPath ?? backupPath,
                  exists: true,
                  valid: true,
                  raw: '{\n  "gateway": { "mode": "local" }\n}\n',
                  config: { gateway: { mode: "local" } },
                });
              },
            })) as typeof import("./io.js").createConfigIO,
          },
        );

        expect(result.recovered).toBe(false);
        expect(result.sourceBackupPath).toBe(backupPath);
        expect(result.issues).toEqual(restoredIssues);
      },
    });
  });

  it("isolates prepare-stage env reads from transaction env state", async () => {
    const configPath = "/tmp/openclaw-transaction-env-prepare.json";
    const env = {
      OPENCLAW_CONFIG_PATH: configPath,
    } as NodeJS.ProcessEnv;
    const snapshots = [
      makeSnapshot({
        path: configPath,
        valid: true,
        config: { gateway: { mode: "local" } },
      }),
      makeSnapshot({
        path: configPath,
        valid: true,
        config: { gateway: { mode: "local" } },
      }),
    ];
    let readIndex = 0;

    const result = await runConfigWriteTransaction(
      {
        config: { gateway: { mode: "local" } },
      },
      {
        env,
        readConfigFileSnapshot: async () => snapshots[Math.min(readIndex++, snapshots.length - 1)],
        writeConfigFile: async () => {},
        createConfigIO: ((options: { configPath?: string; env?: NodeJS.ProcessEnv }) => ({
          writeConfigFile: async () => {},
          readConfigFileSnapshot: async () => {
            if (options.env) {
              options.env.OPENCLAW_TEST_ENV_LEAK = "leaked";
            }
            return makeSnapshot({
              path: options.configPath ?? "/tmp/openclaw-staging.json",
              valid: true,
              config: { gateway: { mode: "local" } },
            });
          },
        })) as unknown as typeof import("./io.js").createConfigIO,
      },
    );

    expect(result.ok).toBe(true);
    expect(env.OPENCLAW_TEST_ENV_LEAK).toBeUndefined();
  });

  it("isolates backup-candidate validation reads from transaction env state", async () => {
    await withConfigCase({
      raw: "{invalid-json",
      run: async (configPath) => {
        const env = {
          OPENCLAW_CONFIG_PATH: configPath,
        } as NodeJS.ProcessEnv;
        await fs.writeFile(`${configPath}.bak`, "{}\n", "utf-8");

        const result = await recoverConfigFromBackups(
          {
            snapshot: makeSnapshot({
              path: configPath,
              exists: true,
              valid: false,
              raw: "{invalid-json",
              issues: [{ path: "<root>", message: "parse failed" }],
            }),
          },
          {
            env,
            createConfigIO: ((options: { configPath?: string; env?: NodeJS.ProcessEnv }) => ({
              readConfigFileSnapshot: async () => {
                if (options.env) {
                  options.env.OPENCLAW_TEST_RECOVERY_ENV_LEAK = "leaked";
                }
                return makeSnapshot({
                  path: options.configPath ?? `${configPath}.bak`,
                  exists: true,
                  valid: true,
                  raw: '{\n  "gateway": { "mode": "local" }\n}\n',
                  config: { gateway: { mode: "local" } },
                });
              },
            })) as unknown as typeof import("./io.js").createConfigIO,
            readConfigFileSnapshot: async () =>
              makeSnapshot({
                path: configPath,
                exists: true,
                valid: true,
                raw: '{\n  "gateway": { "mode": "local" }\n}\n',
                config: { gateway: { mode: "local" } },
              }),
            clearConfigCache: () => {},
          },
        );

        expect(result.recovered).toBe(true);
        expect(env.OPENCLAW_TEST_RECOVERY_ENV_LEAK).toBeUndefined();
      },
    });
  });

  it("treats rollback as successful when pre-transaction hash is unavailable but file is restored", async () => {
    const configPath = "/tmp/openclaw-transaction-rollback-null-hash.json";
    const snapshots = [
      makeSnapshot({
        path: configPath,
        exists: true,
        raw: null,
        valid: true,
      }),
      makeSnapshot({
        path: configPath,
        exists: true,
        raw: '{\n  "gateway": { "mode": "local" }\n}\n',
        valid: true,
        config: { gateway: { mode: "local" } },
      }),
      makeSnapshot({
        path: configPath,
        exists: true,
        raw: null,
        valid: false,
      }),
    ];
    let readIndex = 0;

    const result = await runConfigWriteTransaction(
      {
        config: { gateway: { mode: "local" } },
        verifyCommittedSnapshot: () => false,
        verificationErrorMessage: "forced verify failure",
      },
      {
        readConfigFileSnapshot: async () => snapshots[Math.min(readIndex++, snapshots.length - 1)],
        writeConfigFile: async () => {},
        clearConfigCache: () => {},
        fs: {
          promises: {
            rm: async () => {},
          },
        } as unknown as typeof import("node:fs"),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("verify");
    expect(result.rolledBack).toBe(true);
  });

  it("detects rollback failure when pre-transaction config was absent but file remains", async () => {
    const configPath = "/tmp/openclaw-transaction-rollback-absent.json";
    const snapshots = [
      makeSnapshot({
        path: configPath,
        exists: false,
        raw: null,
        valid: true,
      }),
      makeSnapshot({
        path: configPath,
        exists: true,
        raw: '{\n  "gateway": { "mode": "local" }\n}\n',
        valid: true,
        config: { gateway: { mode: "local" } },
      }),
      makeSnapshot({
        path: configPath,
        exists: true,
        raw: '{\n  "gateway": { "mode": "local" }\n}\n',
        valid: true,
        config: { gateway: { mode: "local" } },
      }),
    ];
    let readIndex = 0;

    const result = await runConfigWriteTransaction(
      {
        config: { gateway: { mode: "local" } },
        verifyCommittedSnapshot: () => false,
        verificationErrorMessage: "forced verify failure",
      },
      {
        readConfigFileSnapshot: async () => snapshots[Math.min(readIndex++, snapshots.length - 1)],
        writeConfigFile: async () => {},
        clearConfigCache: () => {},
        fs: {
          promises: {
            rm: async () => {
              throw new Error("permission denied");
            },
          },
        } as unknown as typeof import("node:fs"),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("rollback");
    expect(result.rolledBack).toBe(false);
    expect(result.error).toContain("rollback did not restore pre-transaction state");
  });
});
