import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { listConfigAuditRecordsForTests } from "../config/io.audit.test-support.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { listSystemAgentAuditEntriesForTests } from "../system-agent/audit.test-support.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

describe("legacy core audit log migration", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("imports config and system audit JSONL only through explicit doctor repair", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-" }, async (stateDir) => {
      const configPath = path.join(stateDir, "logs", "config-audit.jsonl");
      const systemPath = path.join(stateDir, "audit", "system-agent.jsonl");
      const crestodianPath = path.join(stateDir, "audit", "crestodian.jsonl");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(systemPath), { recursive: true });
      const unredactedConfigRecord = {
        ts: "2026-07-01T00:00:00.000Z",
        source: "config-io",
        event: "config.write",
        argv: ["openclaw", "config", "set", "token", "secret-value"],
        execArgv: [],
      };
      const unredactedDigest = createHash("sha256")
        .update(JSON.stringify(unredactedConfigRecord))
        .digest("hex")
        .slice(0, 16);
      await fs.writeFile(configPath, `${JSON.stringify(unredactedConfigRecord)}\n`);
      await fs.writeFile(
        systemPath,
        `${JSON.stringify({
          timestamp: "2026-07-02T00:00:00.000Z",
          operation: "config.set",
          summary: "Set config",
        })}\n`,
      );
      await fs.writeFile(
        crestodianPath,
        `${JSON.stringify({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Restarted gateway",
        })}\n`,
      );

      expect(detectLegacyAuditLogs({ stateDir }).hasLegacy).toBe(false);
      const detected = detectLegacyAuditLogs({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      expect(detected.sources).toHaveLength(3);

      const result = await migrateLegacyAuditLogs({ detected, stateDir });
      expect(result.warnings).toEqual([]);
      expect(result.changes).toHaveLength(6);

      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const configRecords = listConfigAuditRecordsForTests({ env, homedir: () => stateDir });
      expect(configRecords).toHaveLength(1);
      expect(JSON.stringify(configRecords)).not.toContain("secret-value");
      const configEntries = createSqliteAuditRecordStore({
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env,
      }).entries();
      expect(configEntries[0]?.key).not.toContain(unredactedDigest);
      const archivedConfig = await fs.readFile(`${configPath}.migrated`, "utf8");
      expect(archivedConfig).not.toContain("secret-value");
      if (process.platform !== "win32") {
        expect((await fs.stat(`${configPath}.migrated`)).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(archivedConfig.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
      expect(
        listSystemAgentAuditEntriesForTests({ env })
          .map((entry) => entry.value.operation)
          .toSorted(),
      ).toEqual(["config.set", "gateway.restart"]);
      await expect(fs.access(configPath)).rejects.toThrow();
      await expect(fs.access(systemPath)).rejects.toThrow();
      await expect(fs.access(crestodianPath)).rejects.toThrow();
    });
  });

  it("rehashes a checkpointed raw archive before treating it as clean", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-rehash-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const rawPath = `${sourcePath}.migrated.raw`;
      const original = {
        timestamp: "2026-07-03T00:00:00.000Z",
        operation: "gateway.restart",
        summary: "original",
      };
      const modified = { ...original, summary: "modified" };
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, `${JSON.stringify(original)}\n`);
      const stableMtime = new Date("2026-07-03T01:00:00.000Z");
      await fs.utimes(sourcePath, stableMtime, stableMtime);
      await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });
      const checkpointedStat = await fs.stat(rawPath);
      const modifiedRaw = `${JSON.stringify(modified)}\n`;
      expect(Buffer.byteLength(modifiedRaw)).toBe(checkpointedStat.size);
      await fs.writeFile(rawPath, modifiedRaw);
      await fs.utimes(rawPath, checkpointedStat.atime, checkpointedStat.mtime);
      const rewrittenStat = await fs.stat(rawPath);
      expect(rewrittenStat.mtimeMs).toBe(checkpointedStat.mtimeMs);
      expect(rewrittenStat.size).toBe(checkpointedStat.size);

      const detected = detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true });
      expect(detected.sources).toMatchObject([{ sourcePath: rawPath, storage: "raw-archive" }]);
      const result = await migrateLegacyAuditLogs({ detected, stateDir });

      expect(result.warnings.join("\n")).toContain("changed other than by append");
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).map((entry) => entry.value.summary),
      ).toEqual(["original"]);
    });
  });

  it("resumes a deterministic audit claim left by an interrupted Doctor", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-resume-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const claimPath = path.join(
        path.dirname(sourcePath),
        `.${path.basename(sourcePath)}.doctor-importing`,
      );
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        `${JSON.stringify({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Restarted gateway",
        })}\n`,
      );
      await fs.rename(sourcePath, claimPath);

      const detected = detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true });
      expect(detected.sources).toMatchObject([{ sourcePath: claimPath, storage: "claim" }]);
      const result = await migrateLegacyAuditLogs({ detected, stateDir });

      expect(result.warnings).toEqual([]);
      await expect(fs.access(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${sourcePath}.migrated.raw`)).resolves.toBeUndefined();
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toHaveLength(1);

      const tenthRawArchive = `${sourcePath}.migrated.10.raw`;
      await fs.writeFile(
        tenthRawArchive,
        `${JSON.stringify({
          timestamp: "2026-07-04T00:00:00.000Z",
          operation: "gateway.reload",
          summary: "Reloaded gateway",
        })}\n`,
      );
      const numberedRaw = detectLegacyAuditLogs({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      expect(numberedRaw.sources).toMatchObject([
        { sourcePath: tenthRawArchive, storage: "raw-archive" },
      ]);
      await migrateLegacyAuditLogs({ detected: numberedRaw, stateDir });
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toHaveLength(2);
    });
  });

  it("does not resurrect a pruned raw-archive head when later rows are appended", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-late-tail-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const records = ["first", "second", "third"].map((summary, index) => ({
        timestamp: `2026-07-03T00:00:0${index}.000Z`,
        operation: "gateway.restart",
        summary,
      }));
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });
      createSqliteAuditRecordStore({
        scope: SYSTEM_AGENT_AUDIT_SCOPE,
        maxEntries: 3,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }).register("runtime", {
        timestamp: "2026-07-04T00:00:00.000Z",
        operation: "gateway.reload",
        summary: "runtime",
      });
      await fs.appendFile(
        `${sourcePath}.migrated.raw`,
        `${JSON.stringify({
          timestamp: "2026-07-05T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "appended",
        })}\n`,
      );

      const recovered = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(recovered.warnings).toEqual([]);
      expect(recovered.changes.join("\n")).toContain("Recovered 1 later");
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).map((entry) => entry.value.summary),
      ).toEqual(["second", "third", "appended", "runtime"]);
      const rawCheckpoints = createSqliteAuditRecordStore<{ recordCount: number }>({
        scope: "migration.legacy-audit-raw",
        maxEntries: 10_000,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }).entries();
      expect(rawCheckpoints).toHaveLength(1);
      expect(rawCheckpoints[0]?.value.recordCount).toBe(4);
    });
  });

  it("retries raw archive recovery when sanitized archive hardening fails", async () => {
    await withTempDir(
      { prefix: "openclaw-audit-migration-recovery-permissions-" },
      async (stateDir) => {
        const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
        const event = (summary: string) => ({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary,
        });
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, `${JSON.stringify(event("before archive"))}\n`);
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
        await fs.appendFile(
          `${sourcePath}.migrated.raw`,
          `${JSON.stringify(event("later row"))}\n`,
        );
        const probe = await fs.open(path.join(stateDir, "recovery-chmod-probe"), "w");
        const fileHandlePrototype = Object.getPrototypeOf(probe) as {
          chmod(mode: number): Promise<void>;
        };
        await probe.close();
        const originalChmod = fileHandlePrototype.chmod;
        let chmodCalls = 0;
        const chmodSpy = vi.spyOn(fileHandlePrototype, "chmod").mockImplementation(function (
          this: typeof fileHandlePrototype,
          mode: number,
        ) {
          chmodCalls += 1;
          if (chmodCalls === 2) {
            return Promise.reject(new Error("simulated recovery chmod failure"));
          }
          return originalChmod.call(this, mode);
        });

        let failed: Awaited<ReturnType<typeof migrateLegacyAuditLogs>>;
        try {
          failed = await migrateLegacyAuditLogs({
            detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
            stateDir,
          });
        } finally {
          chmodSpy.mockRestore();
        }

        expect(failed.changes).toEqual([]);
        expect(failed.warnings.join("\n")).toContain(
          "Failed securing sanitized system-agent audit log",
        );
        expect(
          detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }).sources,
        ).toMatchObject([{ storage: "raw-archive" }]);

        const recovered = await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
        expect(recovered.warnings).toEqual([]);
        expect(
          listSystemAgentAuditEntriesForTests({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }).map((entry) => entry.value.summary),
        ).toEqual(["before archive", "later row"]);
        expect(
          detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }).sources,
        ).toEqual([]);
      },
    );
  });

  it("keeps identical rows from separate raw archive generations", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-generations-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const record = {
        timestamp: "2026-07-03T00:00:00.000Z",
        operation: "gateway.restart",
        summary: "Repeated operation",
      };
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(`${sourcePath}.migrated.raw`, `${JSON.stringify(record)}\n`);
      await fs.writeFile(`${sourcePath}.migrated.2.raw`, `${JSON.stringify(record)}\n`);
      await fs.writeFile(`${sourcePath}.migrated.10.raw`, `${JSON.stringify(record)}\n`);
      const claimPath = path.join(
        path.dirname(sourcePath),
        `.${path.basename(sourcePath)}.doctor-importing.11`,
      );
      await fs.writeFile(claimPath, `${JSON.stringify(record)}\n`);
      await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);

      const detected = detectLegacyAuditLogs({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      expect(detected.sources.map((source) => path.basename(source.sourcePath))).toEqual([
        "system-agent.jsonl.migrated.raw",
        "system-agent.jsonl.migrated.2.raw",
        "system-agent.jsonl.migrated.10.raw",
        ".system-agent.jsonl.doctor-importing.11",
        "system-agent.jsonl",
      ]);
      const result = await migrateLegacyAuditLogs({ detected, stateDir });

      expect(result.warnings).toEqual([]);
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toHaveLength(5);
      expect(detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
        false,
      );
    });
  });

  it("keeps restored raw archives idempotent after device and inode changes", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-restored-" }, async (rootDir) => {
      const stateDir = path.join(rootDir, "source-state");
      const restoredStateDir = path.join(rootDir, "restored-state");
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        `${JSON.stringify({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Restored operation",
        })}\n`,
      );
      await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });
      resetPluginStateStoreForTests();
      await fs.cp(stateDir, restoredStateDir, { recursive: true });
      createSqliteAuditRecordStore({
        scope: SYSTEM_AGENT_AUDIT_SCOPE,
        maxEntries: 1,
        env: { ...process.env, OPENCLAW_STATE_DIR: restoredStateDir },
      }).register("runtime-after-restore", {
        timestamp: "2026-07-04T00:00:00.000Z",
        operation: "gateway.reload",
        summary: "Runtime after restore",
      });

      const restored = detectLegacyAuditLogs({
        stateDir: restoredStateDir,
        doctorOnlyStateMigrations: true,
      });
      expect(restored.sources).toMatchObject([{ storage: "raw-archive" }]);
      const result = await migrateLegacyAuditLogs({
        detected: restored,
        stateDir: restoredStateDir,
      });

      expect(result.warnings).toEqual([]);
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: restoredStateDir },
        }).map((entry) => entry.value.summary),
      ).toEqual(["Runtime after restore"]);
      expect(
        detectLegacyAuditLogs({
          stateDir: restoredStateDir,
          doctorOnlyStateMigrations: true,
        }).hasLegacy,
      ).toBe(false);
    });
  });

  it("resumes the stable generation of an interrupted sanitized archive", async () => {
    await withTempDir(
      { prefix: "openclaw-audit-migration-sanitized-resume-" },
      async (stateDir) => {
        const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
        const claimPath = path.join(
          path.dirname(sourcePath),
          `.${path.basename(sourcePath)}.doctor-importing`,
        );
        const record = {
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Interrupted operation",
        };
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(claimPath, `${JSON.stringify(record)}\n`);
        await fs.writeFile(`${sourcePath}.migrated`, `${JSON.stringify(record)}\n`);

        const result = await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });

        expect(result.warnings).toEqual([]);
        await expect(fs.access(`${sourcePath}.migrated.raw`)).resolves.toBeUndefined();
        await expect(fs.access(`${sourcePath}.migrated.2.raw`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          listSystemAgentAuditEntriesForTests({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        ).toHaveLength(1);
      },
    );
  });

  it("allocates a new generation when an active source follows a sanitized-only archive", async () => {
    await withTempDir(
      { prefix: "openclaw-audit-migration-sanitized-recreated-" },
      async (stateDir) => {
        const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
        const record = {
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Repeated after downgrade",
        };
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
        await fs.rm(`${sourcePath}.migrated.raw`);
        const firstSanitized = await fs.readFile(`${sourcePath}.migrated`, "utf8");
        await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);

        const repeated = await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });

        expect(repeated.warnings).toEqual([]);
        expect(repeated.changes.join("\n")).toContain("1 new row");
        await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toBe(firstSanitized);
        await expect(fs.access(`${sourcePath}.migrated.2.raw`)).resolves.toBeUndefined();
        expect(
          listSystemAgentAuditEntriesForTests({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        ).toHaveLength(2);
      },
    );
  });

  it("resumes a claim at its reserved generation instead of an older sanitized-only slot", async () => {
    await withTempDir(
      { prefix: "openclaw-audit-migration-claimed-generation-" },
      async (stateDir) => {
        const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
        const secondClaimPath = path.join(
          path.dirname(sourcePath),
          `.${path.basename(sourcePath)}.doctor-importing.2`,
        );
        const record = {
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Repeated after interrupted downgrade",
        };
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
        await fs.rm(`${sourcePath}.migrated.raw`);
        await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);
        await fs.rename(sourcePath, secondClaimPath);

        const detected = detectLegacyAuditLogs({
          stateDir,
          doctorOnlyStateMigrations: true,
        });
        expect(detected.sources).toMatchObject([
          {
            sourcePath: secondClaimPath,
            storage: "claim",
            sanitizedArchivePath: `${sourcePath}.migrated.2`,
            rawArchivePath: `${sourcePath}.migrated.2.raw`,
          },
        ]);
        const resumed = await migrateLegacyAuditLogs({ detected, stateDir });

        expect(resumed.warnings).toEqual([]);
        await expect(fs.access(`${sourcePath}.migrated.2.raw`)).resolves.toBeUndefined();
        expect(
          listSystemAgentAuditEntriesForTests({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        ).toHaveLength(2);
      },
    );
  });

  it("leaves malformed audit sources in place without partial imports", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-invalid-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, "{bad json\n");
      const detected = detectLegacyAuditLogs({
        stateDir,
        doctorOnlyStateMigrations: true,
      });

      const result = await migrateLegacyAuditLogs({ detected, stateDir });
      expect(result.warnings.join("\n")).toContain("Failed reading system-agent audit log");
      await expect(fs.access(sourcePath)).resolves.toBeUndefined();
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toEqual([]);
    });
  });

  it("requires exclusive state ownership before claiming legacy audit files", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-lock-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        `${JSON.stringify({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Restarted gateway",
        })}\n`,
      );
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const gatewayLock = await acquireGatewayLock({
        allowInTests: true,
        env,
        pollIntervalMs: 10,
        port: 18_791,
        timeoutMs: 100,
      });
      if (!gatewayLock) {
        throw new Error("expected test Gateway lock");
      }

      let result: Awaited<ReturnType<typeof migrateLegacyAuditLogs>>;
      try {
        result = await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
      } finally {
        await gatewayLock.release();
      }

      expect(result.warnings.join("\n")).toContain("exclusive state ownership is unavailable");
      await expect(fs.access(sourcePath)).resolves.toBeUndefined();
      expect(listSystemAgentAuditEntriesForTests({ env })).toEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects audit sources beneath symlinked state parents",
    async () => {
      const externalAuditDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-audit-migration-external-"),
      );
      try {
        await withTempDir({ prefix: "openclaw-audit-migration-symlink-" }, async (stateDir) => {
          const externalSource = path.join(externalAuditDir, "system-agent.jsonl");
          await fs.writeFile(
            externalSource,
            `${JSON.stringify({
              timestamp: "2026-07-03T00:00:00.000Z",
              operation: "gateway.restart",
              summary: "Outside state root",
            })}\n`,
          );
          await fs.symlink(externalAuditDir, path.join(stateDir, "audit"));
          const detected = detectLegacyAuditLogs({
            stateDir,
            doctorOnlyStateMigrations: true,
          });

          const result = await migrateLegacyAuditLogs({ detected, stateDir });

          expect(result.changes).toEqual([]);
          expect(result.warnings.join("\n")).toMatch(/alias|symlink|outside workspace/u);
          await expect(fs.readFile(externalSource, "utf8")).resolves.toContain(
            "Outside state root",
          );
          await expect(fs.access(`${externalSource}.migrated`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(
            listSystemAgentAuditEntriesForTests({
              env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
            }),
          ).toEqual([]);
        });
      } finally {
        await fs.rm(externalAuditDir, { recursive: true, force: true });
      }
    },
  );
});
