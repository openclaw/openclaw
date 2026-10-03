// Covers Doctor-only import of the retired exec approvals JSON file.
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolveExecApprovalsPath } from "./exec-approvals-config.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { loadExecApprovals } from "./exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "./exec-approvals-store.test-support.js";
import { resolveExecApprovalsLocked } from "./exec-approvals.js";
import { requestExecHostViaSocket } from "./exec-host.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyExecApprovals,
  inspectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "./state-migrations.exec-approvals.js";

type MigrationDatabase = Pick<OpenClawStateKyselyDatabase, "migration_runs" | "migration_sources">;

describe("legacy exec approvals migration", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      envSnapshot.restore();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string; sourcePath: string } {
    const stateDir = tempDirs.make("openclaw-exec-approvals-migration-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    return { env, stateDir, sourcePath: resolveExecApprovalsPath(env) };
  }

  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let sourcePath: string;
  beforeEach(() => {
    ({ stateDir, env, sourcePath } = useStateDir());
  });

  async function writeLegacy(targetPath: string, value: unknown): Promise<string> {
    await fsp.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return targetPath;
  }

  async function migrate(
    params: {
      env?: NodeJS.ProcessEnv;
      stateDir?: string;
      beforeClaim?: () => void;
      beforeVerify?: () => void;
      removeSource?: (sourcePath: string) => Promise<void> | void;
      keepCanonical?: boolean;
    } = {},
  ) {
    return await migrateLegacyExecApprovals({
      env,
      stateDir,
      detected: detectLegacyExecApprovals({
        stateDir: params.stateDir ?? stateDir,
        doctorOnlyStateMigrations: true,
      }),
      ...params,
    });
  }

  function database() {
    return openOpenClawStateDatabase({ env }).db;
  }

  function receipt() {
    const db = database();
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_sources")
        .selectAll()
        .where("migration_kind", "=", "legacy-exec-approvals-json"),
    );
  }

  function runReceipt() {
    const db = database();
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_runs")
        .selectAll()
        .where("id", "like", "exec-approvals-json:%"),
    );
  }

  it("imports nullable and absent usage metadata and releases the runtime gate", async () => {
    const usage = { lastUsedAt: null, lastUsedCommand: null };
    const expected = {
      version: 1 as const,
      socket: { path: "/tmp/approvals.sock", token: "secret" },
      defaults: { security: "allowlist" as const, ask: "on-miss" as const },
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/rg", ...usage }] },
        "*": {
          allowlist: [
            { pattern: "/usr/bin/unused" },
            { pattern: "/usr/bin/used", lastUsedAt: 0, lastUsedCommand: "" },
          ],
        },
      },
    };
    await writeLegacy(sourcePath, expected);
    expect(detectLegacyExecApprovals({ stateDir }).hasLegacy).toBe(false);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    execApprovalsStoreTesting.reset();
    expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Imported legacy exec approvals into shared SQLite state."]);
    expect(result.notices).toEqual([
      "Removed retired exec approvals JSON after recording its migration decision.",
    ]);
    const imported = loadExecApprovals();
    expect(imported.defaults).toMatchObject(expected.defaults);
    expect(imported.socket).toEqual(expected.socket);
    expect(imported.agents?.main?.allowlist).toEqual([
      { id: expect.any(String), pattern: "/usr/bin/rg" },
    ]);
    expect(imported.agents?.["*"]?.allowlist).toEqual([
      { id: expect.any(String), pattern: "/usr/bin/unused" },
      { id: expect.any(String), pattern: "/usr/bin/used", lastUsedAt: 0, lastUsedCommand: "" },
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt()).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      status: "completed",
      target_table: "exec_approvals_config",
    });
    expect(runReceipt()).toMatchObject({ status: "completed" });
  });

  it.each([
    { name: "empty unversioned stub", socket: undefined, canonical: "missing" },
    { name: "token-only stub", socket: { token: " fixture " }, canonical: "missing" },
    {
      name: "socket stub with valid policy",
      socket: { path: "/tmp/old.sock", token: "fixture" },
      canonical: "valid",
    },
    {
      name: "socket stub with invalid policy",
      socket: { path: "/tmp/old.sock", token: "fixture" },
      canonical: "invalid",
    },
  ])("retires $name", async ({ socket, canonical }) => {
    const stub = { defaults: {}, agents: {}, ...(socket ? { socket } : {}) };
    const claimed = canonical === "valid";
    const policy = { version: 1 as const, defaults: { security: "deny" as const }, agents: {} };
    if (canonical !== "missing") {
      writeExecApprovalsConfigRow({
        db: database(),
        file: policy,
        raw: canonical === "invalid" ? "{invalid" : undefined,
      });
    }
    const originalRow = readExecApprovalsConfigRow(database());
    await writeLegacy(claimed ? `${sourcePath}.doctor-importing` : sourcePath, stub);
    const original = await fsp.readFile(claimed ? `${sourcePath}.doctor-importing` : sourcePath);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    const expectedSocket = {
      path: socket?.path?.trim() || undefined,
      token: socket?.token?.trim() || undefined,
    };
    if (canonical === "missing" && (expectedSocket.path || expectedSocket.token)) {
      expect(loadExecApprovals().socket).toEqual(expectedSocket);
    } else {
      expect(readExecApprovalsConfigRow(database())).toEqual(originalRow);
    }
    expect(() => loadExecApprovals()).not.toThrow();
    const archives = (await fsp.readdir(stateDir)).filter((name) =>
      name.startsWith("exec-approvals.json.migrated."),
    );
    expect(archives).toHaveLength(1);
    expect(await fsp.readFile(`${stateDir}/${archives[0]}`)).toEqual(original);
    expect(receipt()).toMatchObject({ removed_source: 1, status: "completed" });
    await expect(migrate()).resolves.toEqual({ changes: [], warnings: [] });
  });

  it.runIf(process.platform !== "win32")(
    "keeps a running exec peer authenticated after retiring an empty socket stub",
    async () => {
      stateDir = tempDirs.make("oc-ea-", "/tmp");
      env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      sourcePath = resolveExecApprovalsPath(env);
      const socketPath = path.join(stateDir, "exec-approvals.sock");
      const originalToken = "synthetic-stable-socket-token";
      const sockets = new Set<net.Socket>();
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let wire = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          wire += chunk;
        });
        socket.on("end", () => {
          const envelope = JSON.parse(wire) as {
            id: string;
            nonce: string;
            ts: number;
            requestJson: string;
            hmac: string;
          };
          const hmac = createHmac("sha256", originalToken)
            .update(`${envelope.nonce}:${envelope.ts}:${envelope.requestJson}`)
            .digest("hex");
          socket.end(
            `${JSON.stringify({
              type: "exec-res",
              id: envelope.id,
              ...(envelope.hmac === hmac
                ? {
                    ok: true,
                    payload: {
                      exitCode: 0,
                      timedOut: false,
                      success: true,
                      stdout: "",
                      stderr: "",
                    },
                  }
                : { ok: false, error: { code: "INVALID_REQUEST", message: "invalid auth" } }),
            })}\n`,
          );
        });
      });
      try {
        const listening = once(server, "listening");
        server.listen(socketPath);
        await listening;
        await writeLegacy(sourcePath, {
          defaults: {},
          agents: {},
          socket: { path: socketPath, token: originalToken },
        });
        setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
        expect((await migrate({ env, stateDir })).warnings).toEqual([]);
        const resolved = await resolveExecApprovalsLocked(undefined, { requireSocket: true });
        await expect(
          requestExecHostViaSocket({
            socketPath: resolved.socketPath,
            token: resolved.token,
            request: { command: ["synthetic-no-execution"] },
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({ ok: true });
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  function legacyWithInvalidEntry(entry: unknown, agentKey = "private-marker-agent"): string {
    return JSON.stringify({
      version: 1,
      socket: { path: "/private-marker/socket", token: "private-marker-token" },
      agents: {
        first: { allowlist: ["/usr/bin/true"] },
        [agentKey]: { allowlist: ["/usr/bin/true", entry] },
        third: { security: "deny" },
      },
    });
  }

  it.each([
    {
      name: "invalid string metadata alongside nullable usage",
      raw: legacyWithInvalidEntry({
        pattern: "private-marker",
        lastUsedAt: null,
        lastUsedCommand: 42,
      }),
      problem: "agents entry #2.allowlist[1].lastUsedCommand: expected a string",
    },
    {
      name: "null policy alongside historical null usage",
      raw: JSON.stringify({
        version: 1,
        defaults: { security: null },
        agents: { main: { allowlist: [{ pattern: "private-marker", lastUsedAt: null }] } },
      }),
      problem: "defaults.security: expected a supported value",
    },
    {
      name: "hostile long keys, values, and multiple failures",
      raw: legacyWithInvalidEntry(
        {
          pattern: "/private-marker/pattern",
          lastUsedAt: { ["private-marker-value".repeat(1_000)]: "private-marker" },
          lastUsedCommand: 42,
        },
        "private-marker-\n\u001b[31m".repeat(1_000),
      ),
      problem: "agents entry #2.allowlist[1].lastUsedAt: expected a finite number",
    },
    {
      name: "socket token",
      raw: JSON.stringify({ version: 1, socket: { token: { "private-marker": true } } }),
      problem: "socket.token: expected a string",
    },
    {
      name: "whole entry shape",
      raw: legacyWithInvalidEntry(42),
      problem:
        "agents entry #2.allowlist[1]: expected a non-empty string or an object with a non-empty pattern",
    },
    {
      name: "blank string entry",
      raw: legacyWithInvalidEntry("  "),
      problem: "agents entry #2.allowlist[1]: expected a non-empty string",
    },
    {
      name: "blank object pattern without a union wrapper",
      raw: legacyWithInvalidEntry({ pattern: "  " }),
      problem: "agents entry #2.allowlist[1].pattern: expected a non-empty string",
    },
    {
      name: "unversioned policy is not an empty stub",
      raw: JSON.stringify({ defaults: { security: "deny" }, agents: {} }),
      problem: "version: expected a supported value",
    },
    {
      name: "JSON syntax",
      raw: "{malformed-private-marker",
      problem: "invalid JSON syntax",
    },
    {
      name: "UTF-8 encoding",
      raw: Buffer.concat([Buffer.from("private-marker"), Buffer.from([0xff])]),
      problem: "invalid UTF-8 encoding",
    },
  ])(
    "diagnoses $name while preserving bytes and a non-removal receipt",
    async ({ raw, problem }) => {
      const original = Buffer.from(raw);
      await fsp.writeFile(sourcePath, original);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);

      const result = await migrate();

      expect(result.changes).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(problem);
      expect(result.warnings[0]).toContain(sourcePath);
      expect(result.warnings[0]).toContain("reconcile this file");
      expect(result.warnings[0]).not.toContain("doctor --fix");
      expect(result.warnings[0]!.length - sourcePath.length).toBeLessThan(400);
      expect(JSON.stringify(result)).not.toContain("private-marker");
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
      const sourceReceipt = receipt();
      expect(sourceReceipt).toMatchObject({
        removed_source: 0,
        source_record_count: 0,
        status: "completed",
        source_size_bytes: original.length,
      });
      const report = {
        source: "legacy-exec-approvals-json",
        target: "exec_approvals_config",
        decision: "malformed-legacy-preserved",
        sourceSha256: createHash("sha256").update(original).digest("hex"),
        sourceValid: false,
        importedRecordCount: 0,
        preservedSqliteRecordCount: 0,
        removesSource: false,
      };
      expect(JSON.parse(sourceReceipt?.report_json ?? "null")).toEqual(report);
      expect(JSON.parse(runReceipt()?.report_json ?? "null")).toEqual(report);
      expect(JSON.stringify([sourceReceipt, runReceipt()])).not.toContain("private-marker");
      expect(readExecApprovalsConfigRow(database())).toBeUndefined();
      expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);
      expect(await migrate()).toEqual(result);
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);
    },
  );

  it("removes a byte-identical source when canonical state already exists", async () => {
    const file = { version: 1 as const, defaults: { security: "deny" as const }, agents: {} };
    const raw = serializeExecApprovals(file);
    writeExecApprovalsConfigRow({ db: database(), file, raw });
    await fsp.writeFile(sourcePath, raw, "utf8");

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Preserved byte-identical canonical SQLite exec approvals."]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt()).toMatchObject({ removed_source: 1 });
  });

  it("preserves conflicting legacy bytes while canonical SQLite wins", async () => {
    const canonical = {
      version: 1 as const,
      defaults: { security: "deny" as const },
      agents: {},
    };
    writeExecApprovalsConfigRow({ db: database(), file: canonical });
    await writeLegacy(sourcePath, {
      version: 1,
      defaults: { security: "full" },
      agents: {},
    });

    const result = await migrate();

    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain("Conflicting legacy exec approvals remain");
    expect(result.warnings[0]).toContain(sourcePath);
    expect(result.warnings[0]).toContain("reconcile this file");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readExecApprovalsConfigRow(database())?.raw_json).toBe(
      serializeExecApprovals(canonical),
    );
    expect(receipt()).toMatchObject({ removed_source: 0 });
  });

  it("previews a conflict without revealing credentials, patterns, or changing policy", async () => {
    const canonical = { version: 1 as const, defaults: { security: "deny" as const }, agents: {} };
    writeExecApprovalsConfigRow({ db: database(), file: canonical });
    await writeLegacy(sourcePath, {
      version: 1,
      defaults: { security: "full" },
      socket: { token: "synthetic-private-token" },
      agents: {
        "synthetic-private-agent": { allowlist: [{ pattern: "synthetic-private-command" }] },
      },
    });
    const original = await fsp.readFile(sourcePath);
    const inspection = await inspectLegacyExecApprovals({ env, stateDir });
    expect(inspection).toMatchObject({
      pending: true,
      policyMatches: false,
      socketMatches: false,
      current: { valid: true, defaults: { security: "deny" }, agentCount: 0 },
      legacy: { valid: true, defaults: { security: "full" }, agentCount: 1, allowlistCount: 1 },
    });
    expect(JSON.stringify(inspection)).not.toContain("synthetic-private");
    expect(await fsp.readFile(sourcePath)).toEqual(original);
    expect(readExecApprovalsConfigRow(database())?.raw_json).toBe(
      serializeExecApprovals(canonical),
    );
    expect(receipt()).toBeUndefined();
  });

  it("compares matching authorization rules without generated or usage metadata", async () => {
    const policy = {
      version: 1,
      agents: {
        main: {
          allowlist: ["/usr/bin/true"],
          mcpTools: [
            {
              server: "synthetic-tools",
              tool: "synthetic-run",
              source: "allow-always" as const,
              addedAt: 100,
              lastUsedAt: 200,
            },
          ],
        },
      },
    };
    await writeLegacy(sourcePath, policy);
    const db = database();
    writeExecApprovalsConfigRow({
      db,
      file: {
        version: 1,
        agents: {
          main: {
            allowlist: [
              {
                pattern: "/usr/bin/true",
                lastUsedAt: 300,
                lastUsedCommand: "/usr/bin/true",
                lastResolvedPath: "/usr/bin/true",
              },
            ],
            mcpTools: [
              {
                server: "synthetic-tools",
                tool: "synthetic-run",
                source: "allow-always",
                addedAt: 300,
                lastUsedAt: 400,
              },
            ],
          },
        },
      },
    });
    const original = readExecApprovalsConfigRow(db);
    expect(await inspectLegacyExecApprovals({ env, stateDir })).toMatchObject({
      policyMatches: true,
    });
    expect(await inspectLegacyExecApprovals({ env, stateDir })).toMatchObject({
      policyMatches: true,
    });
    expect(readExecApprovalsConfigRow(db)).toEqual(original);
    await writeLegacy(sourcePath, {
      version: 1,
      agents: { main: { allowlist: ["/usr/bin/false"] } },
    });
    expect(await inspectLegacyExecApprovals({ env, stateDir })).toMatchObject({
      policyMatches: false,
    });
  });

  it("explicitly archives conflicting legacy bytes while preserving the exact current row", async () => {
    const canonical = { version: 1 as const, defaults: { security: "deny" as const }, agents: {} };
    writeExecApprovalsConfigRow({ db: database(), file: canonical });
    await writeLegacy(sourcePath, { version: 1, defaults: { security: "full" }, agents: {} });
    const original = await fsp.readFile(sourcePath);
    const result = await migrate({ keepCanonical: true });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Preserved current SQLite exec approvals and archived the legacy file.",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(readExecApprovalsConfigRow(database())?.raw_json).toBe(
      serializeExecApprovals(canonical),
    );
    const archive = (await fsp.readdir(stateDir)).find((name) =>
      name.startsWith("exec-approvals.json.migrated."),
    );
    expect(archive).toBeDefined();
    expect(await fsp.readFile(path.join(stateDir, archive!))).toEqual(original);
    if (process.platform !== "win32") {
      expect((await fsp.stat(path.join(stateDir, archive!))).mode & 0o777).toBe(0o600);
    }
    expect(receipt()).toMatchObject({ removed_source: 1 });
    await expect(migrate({ keepCanonical: true })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it.each(["missing", "invalid"])(
    "refuses to keep %s canonical policy without importing legacy",
    async (kind) => {
      if (kind === "invalid") {
        writeExecApprovalsConfigRow({ db: database(), file: { version: 1 }, raw: "{invalid" });
      }
      const before = readExecApprovalsConfigRow(database());
      await writeLegacy(sourcePath, { version: 1, defaults: { security: "full" }, agents: {} });
      const original = await fsp.readFile(sourcePath);
      const result = await migrate({ keepCanonical: true });
      expect(result.warnings.join(" ")).toContain("valid canonical SQLite policy is required");
      expect(
        (await fsp.readdir(stateDir)).filter((name) =>
          name.startsWith("exec-approvals.json.migrated."),
        ),
      ).toEqual([]);
      expect(await fsp.readFile(sourcePath)).toEqual(original);
      expect(readExecApprovalsConfigRow(database())).toEqual(before);
      expect(receipt()).toBeUndefined();
    },
  );

  it("repairs an invalid canonical row from validated legacy policy", async () => {
    const db = database();
    db.prepare(
      "INSERT INTO exec_approvals_config (config_key, raw_json, socket_path, has_socket_token, default_security, default_ask, default_ask_fallback, auto_allow_skills, agent_count, allowlist_count, updated_at_ms) VALUES ('current', '{invalid', NULL, 0, NULL, NULL, NULL, NULL, 0, 0, 1)",
    ).run();
    await writeLegacy(sourcePath, { version: 1, defaults: { security: "deny" }, agents: {} });

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Replaced an invalid SQLite exec approvals row with validated legacy state.",
    ]);
    expect(readExecApprovalsConfigRow(database())?.raw_json).toContain('"security": "deny"');
  });

  it("preserves changed source bytes before claim and writes no receipt", async () => {
    await writeLegacy(sourcePath, { version: 1, agents: {} });

    const result = await migrate({
      beforeVerify: () => {
        fs.writeFileSync(
          sourcePath,
          serializeExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} }),
        );
      },
    });

    expect(result.warnings[0]).toContain("changed after migration loaded");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt()).toBeUndefined();
  });

  it.each([
    {
      name: "null-metadata import",
      value: {
        version: 1,
        agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", lastUsedAt: null }] } },
      },
    },
    { name: "empty stub retirement", value: { defaults: {}, agents: {} } },
  ])("retains $name claim after cleanup failure and converges on retry", async ({ value }) => {
    await writeLegacy(sourcePath, value);
    const first = await migrate({
      removeSource: () => {
        throw new Error("forced cleanup failure");
      },
    });
    expect(first.warnings[0]).toContain("cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt()).toMatchObject({ removed_source: 0 });

    const second = await migrate();
    expect(second.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt()).toMatchObject({ removed_source: 1 });
  });

  it("requires exclusive state ownership and prints the stop-Gateway warning", async () => {
    await writeLegacy(sourcePath, { version: 1, agents: {} });
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
    let result: Awaited<ReturnType<typeof migrateLegacyExecApprovals>>;
    try {
      result = await migrate();
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("Stop the Gateway");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt()).toBeUndefined();
  });
});
