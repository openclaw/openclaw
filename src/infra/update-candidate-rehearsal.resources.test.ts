import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOwnedManagedUpdateEnv } from "../cli/update-cli/update-command-service-env.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObject } from "../config/validation.js";
import { exitCodeFromFindings, runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import type { HealthCheck } from "../flows/health-checks.js";
import * as exec from "../process/exec.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "../state/openclaw-agent-schema-v25.test-support.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import * as diskSpace from "./disk-space.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { assessInitialUpdateSnapshotCapacity } from "./update-candidate-snapshot.js";
import {
  captureUpdateCandidateDeadline,
  materializeUpdateCandidateStateWorker,
} from "./update-candidate-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function prepare(
  { root, stateDir }: { root: string; stateDir: string },
  options: Partial<Parameters<typeof prepareUpdateCandidateRehearsal>[0]> = {},
) {
  return prepareUpdateCandidateRehearsal({
    config: {},
    stateDir,
    candidateRoot: root,
    env: {},
    ...options,
  });
}

async function cleanup(pending: ReturnType<typeof prepare>) {
  await pending.then(
    (rehearsal) => rehearsal.cleanup(),
    () => undefined,
  );
}

async function withRehearsal(
  pending: ReturnType<typeof prepare>,
  run: (rehearsal: Awaited<typeof pending>) => Promise<void>,
) {
  try {
    await run(await pending);
  } finally {
    await cleanup(pending);
  }
}

function capacity(available: (target: string) => number | null, totalBytes = 1024 ** 3) {
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
    const availableBytes = available(targetPath);
    return availableBytes === null
      ? null
      : { targetPath, checkedPath: targetPath, availableBytes, totalBytes };
  });
}

async function expectSize(file: string, size: number) {
  expect((await fs.stat(file)).size).toBe(size);
}

async function fixture(sizeMiB = 0, ids = ["main"], worker = true) {
  const root = tempDirs.make("candidate-resources-");
  if (worker) {
    await materializeUpdateCandidateStateWorker(root);
  }
  const stateDir = path.join(root, "source");
  const files = ids.map((id) =>
    path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite"),
  );
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    using db = openNodeSqliteDatabase(file);
    db.exec("CREATE TABLE evidence (value BLOB)");
    db.prepare("INSERT INTO evidence VALUES (zeroblob(?))").run(sizeMiB * 1024 ** 2);
  }
  return { root, stateDir, files, file: files[0]! };
}

it.each([
  { table: "retained", index: "retained_value", fullIntegrityCheck: undefined, rejects: false },
  { table: "retained", index: "retained_value", fullIntegrityCheck: true, rejects: true },
  { table: "state_leases", index: "lease_value", fullIntegrityCheck: undefined, rejects: true },
])(
  "checks $table indexes before rewriting a rehearsal (full=$fullIntegrityCheck)",
  async ({ table, index, fullIntegrityCheck, rejects }) => {
    const input = await fixture();
    const file =
      table === "retained" ? input.file : path.join(input.stateDir, "state/openclaw.sqlite");
    await fs.mkdir(path.dirname(file), { recursive: true });
    {
      using db = openNodeSqliteDatabase(file);
      db.exec(`
        CREATE TABLE ${table}(value TEXT, alternate TEXT);
        CREATE INDEX ${index} ON ${table}(value);
        INSERT INTO ${table} VALUES ('alpha', 'zeta'), ('beta', 'eta');
      `);
      db.enableDefensive?.(false);
      db.exec(`
        PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = 'CREATE INDEX ${index} ON ${table}(alternate)'
        WHERE name = '${index}';
        PRAGMA writable_schema = OFF;
      `);
    }
    const before = await fs.readFile(file);
    const pending = prepare(input, { fullIntegrityCheck });
    if (rejects) {
      await expect(pending).rejects.toThrow(new RegExp(`integrity_check.*${index}`, "su"));
    } else {
      await withRehearsal(pending, async (rehearsal) => {
        using copied = openNodeSqliteDatabase(
          path.join(rehearsal.stateDir, path.relative(input.stateDir, input.file)),
          { readOnly: true },
        );
        expect(copied.prepare("SELECT * FROM retained NOT INDEXED").all()).toEqual([
          { value: "alpha", alternate: "zeta" },
          { value: "beta", alternate: "eta" },
        ]);
      });
    }
    expect(await fs.readFile(file)).toEqual(before);
  },
);

async function syntheticSnapshotWorker(body: string) {
  const root = tempDirs.make("candidate-progress-");
  const stateDir = path.join(root, "source");
  const receipt = path.join(root, "child.json");
  const worker = path.join(root, "dist", "infra", "update-candidate-state.worker.js");
  await fs.mkdir(stateDir);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    worker,
    `
      import fs from "node:fs/promises";
      import path from "node:path";
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      const input = JSON.parse(text);
      if (input.mode === "inventory") {
        process.stdout.write(JSON.stringify({ databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json", warnings: [] }));
        process.exit(0);
      }
      const scratch = path.join(input.targetStateDir, ".sqlite-snapshot-fixture");
      await fs.mkdir(scratch);
      await fs.writeFile(${JSON.stringify(receipt)}, JSON.stringify({
        pid: process.pid,
        directory: input.targetStateDir,
      }));
      ${body}
    `,
  );
  return { root, stateDir, receipt };
}

it("reaps an expired snapshot worker before removing its database and WAL scratch", async () => {
  const { root, stateDir, receipt } = await syntheticSnapshotWorker(
    `
      await fs.writeFile(path.join(scratch, "database.sqlite"), "partial database");
      await fs.writeFile(path.join(scratch, "database.sqlite-wal"), "partial WAL");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      process.stderr.write("snapshot fixture ready\\n");
    `,
  );
  const now = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  const ready = createDeferred();
  const run = exec.runUtf8CommandWithTimeout;
  vi.spyOn(exec, "runUtf8CommandWithTimeout").mockImplementation((argv, options) => {
    if (typeof options === "number") {
      return run(argv, options);
    }
    let stderr = "";
    return run(argv, {
      ...options,
      onOutputChunk(chunk, stream) {
        options.onOutputChunk?.(chunk, stream);
        if (stream === "stderr") {
          stderr += chunk.toString();
          if (stderr.includes("snapshot fixture ready\n")) {
            ready.resolve();
          }
        }
      },
    });
  });
  const expireDeadline = captureUpdateCandidateDeadline();
  const cancel = new AbortController();
  const operation = prepare(
    { root, stateDir },
    {
      timeoutMs: 300_000,
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]),
    },
  );
  const prematureExit = operation.then(() => {
    throw new Error("Stalled snapshot unexpectedly completed");
  });
  try {
    await Promise.race([ready.promise, prematureExit]);
    elapsed = 400_000;
    expireDeadline();
    await expect(operation).rejects.toThrow(/snapshot exceeded its.*Check storage performance/);
    const child = z
      .object({ pid: z.number().int().positive(), directory: z.string() })
      .parse(JSON.parse(await fs.readFile(receipt, "utf8")));
    expect(() => process.kill(child.pid, 0)).toThrow();
    await expect(fs.stat(child.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  } finally {
    cancel.abort();
    await operation.catch(() => undefined);
  }
});

it("keeps the SQLite startup floor when the caller supplies a smaller timeout", async () => {
  const f = await fixture(8);
  await withRehearsal(prepare(f, { timeoutMs: 1 }), async (rehearsal) => {
    using db = openNodeSqliteDatabase(
      path.join(rehearsal.stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    );
    expect(db.prepare("SELECT length(value) AS bytes FROM evidence").get()).toEqual({
      bytes: 8 * 1024 * 1024,
    });
  });
});

it.each([false, true])(
  "admits snapshot capacity before copying (state volume full: %s)",
  async (full) => {
    const f = await fixture();
    const before = await fs.readFile(f.file);
    capacity(
      (target) => (!full && target === `${f.stateDir}.update-captures` ? 10 * 1024 ** 3 : 0),
      10 * 1024 ** 3,
    );
    const pending = prepare(f);
    if (full) {
      try {
        const outcome = await pending.then(
          () => "unexpected success",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(outcome).toMatch(/snapshot.*requires.*available/i);
        expect(outcome).toContain(os.tmpdir());
        expect(outcome).toContain(`${f.stateDir}.update-captures`);
        expect(await fs.readdir(f.stateDir)).toEqual(["agents"]);
      } finally {
        await cleanup(pending);
      }
    } else {
      await withRehearsal(pending, async (rehearsal) => {
        expect(
          rehearsal.stateDir.startsWith(
            `${await fs.realpath(f.stateDir)}.update-captures${path.sep}`,
          ),
        ).toBe(true);
        expect(rehearsal.env).toMatchObject({
          TMPDIR: rehearsal.stateDir,
          XDG_CACHE_HOME: path.join(rehearsal.stateDir, "cache"),
        });
      });
    }
    expect(await fs.readFile(f.file)).toEqual(before);
  },
);

it.each([
  { explicit: 1024 ** 3, state: 1024 ** 3, system: 1024 ** 3, kind: "explicit-tmpdir" },
  { explicit: 0, state: 1024 ** 3, system: 1024 ** 3, kind: "state-volume" },
  { explicit: 0, state: 0, system: 1024 ** 3, kind: "system-tmpdir" },
  { explicit: null, state: 1024 ** 3, system: null, kind: "state-volume" },
])("selects $kind from measured snapshot capacity", async ({ explicit, state, system, kind }) => {
  const f = await fixture();
  const nominated = path.join(f.root, "operator-temp");
  await fs.mkdir(nominated);
  const sibling = `${f.stateDir}.update-captures`;
  capacity((target) => (target === nominated ? explicit : target === sibling ? state : system));
  await withRehearsal(
    prepare(f, {
      env: resolveOwnedManagedUpdateEnv({
        processEnv: { TMPDIR: nominated },
        serviceEnv: { TMPDIR: "/tmp", OPENCLAW_STATE_DIR: f.stateDir },
      }),
    }),
    async (rehearsal) => {
      const root =
        kind === "explicit-tmpdir" ? nominated : kind === "state-volume" ? sibling : os.tmpdir();
      expect(rehearsal.stateDir.startsWith(`${await fs.realpath(root)}${path.sep}`)).toBe(true);
      expect(rehearsal.snapshotCapacity).toMatchObject({
        reason: kind,
        selection: { kind, directory: rehearsal.stateDir },
        candidates: [
          { kind: "explicit-tmpdir", directory: nominated, availableBytes: explicit },
          { kind: "state-volume", directory: sibling, availableBytes: state },
          { kind: "system-tmpdir", directory: os.tmpdir(), availableBytes: system },
        ],
      });
    },
  );
});

it("skips an explicit temporary path that is a file without changing it", async () => {
  const f = await fixture();
  const nominated = path.join(f.root, "operator-file");
  await fs.writeFile(nominated, "preserved");
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: path.dirname(targetPath),
    availableBytes: 1024 ** 3,
    totalBytes: 1024 ** 3,
  }));
  await withRehearsal(prepare(f, { env: { TMPDIR: nominated } }), async (rehearsal) => {
    expect(rehearsal.snapshotCapacity).toMatchObject({
      reason: "state-volume",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          directory: nominated,
          allocationError: expect.stringContaining("directory"),
        }),
      ]),
    });
    expect(await fs.readFile(nominated, "utf8")).toBe("preserved");
  });
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "falls back when the state sibling parent is not writable",
  async () => {
    const f = await fixture();
    await fs.chmod(f.root, 0o500);
    let rehearsal: Awaited<ReturnType<typeof prepareUpdateCandidateRehearsal>> | undefined;
    try {
      rehearsal = await prepare(f);
      expect(rehearsal.snapshotCapacity).toMatchObject({
        reason: "system-tmpdir",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            directory: `${f.stateDir}.update-captures`,
            allocationError: expect.stringContaining("EACCES"),
          }),
        ]),
      });
    } finally {
      await fs.chmod(f.root, 0o700);
      await rehearsal?.cleanup();
    }
  },
);

it.each([false, true])(
  "budgets active plugin payloads before copying (all volumes full: %s)",
  async (full) => {
    const f = await fixture();
    const plugin = path.join(f.stateDir, "npm/projects/demo/node_modules/demo");
    const nominated = path.join(f.root, "operator-temp");
    await fs.mkdir(nominated);
    await fs.mkdir(plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, "package.json"), '{"name":"demo"}');
    const payload = path.join(plugin, "payload.bin");
    await fs.writeFile(payload, "");
    await fs.truncate(payload, 160 * 1024 ** 2);
    const sibling = `${await fs.realpath(f.stateDir)}.update-captures`;
    capacity((target) => (!full && target === sibling ? 1024 ** 3 : 128 * 1024 ** 2));
    const worker = vi.spyOn(exec, "runCommandBuffered");
    const pending = prepare(f, {
      config: { plugins: { installs: { demo: { source: "npm", installPath: plugin } } } },
      env: { TMPDIR: nominated },
    });
    try {
      if (full) {
        await expect(pending).rejects.toMatchObject({
          capacity: {
            pluginBytes: expect.any(Number),
            requiredBytes: expect.any(Number),
            selection: null,
            candidates: expect.arrayContaining([
              expect.objectContaining({ directory: sibling, availableBytes: 128 * 1024 ** 2 }),
            ]),
          },
        });
        expect(
          worker.mock.calls.some(([, opts]) => JSON.parse(String(opts?.input)).mode === "snapshot"),
        ).toBe(false);
      } else {
        const rehearsal = await pending;
        expect(rehearsal.stateDir.startsWith(sibling + path.sep)).toBe(true);
        expect(rehearsal).toMatchObject({
          snapshotCapacity: {
            pluginBytes: expect.any(Number),
            selection: { kind: "state-volume", directory: rehearsal.stateDir },
          },
        });
        await expectSize(
          path.join(rehearsal.stateDir, "npm/projects/demo/node_modules/demo/payload.bin"),
          160 * 1024 ** 2,
        );
      }
    } finally {
      await cleanup(pending);
    }
    await expectSize(payload, 160 * 1024 ** 2);
    expect(await fs.readdir(nominated)).toEqual([]);
  },
);

const capacityFailure = { capacity: { reason: "snapshot-capacity-insufficient" } };
async function capacityFixture(mebibytes: number | null, worker = false) {
  const f = await fixture(8, ["main", "second"], worker);
  capacity(() => (mebibytes === null ? null : mebibytes * 1024 ** 2));
  const hashes = () =>
    Promise.all(
      f.files.map(async (file) =>
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
      ),
    );
  const before = await hashes();
  return {
    ...f,
    assess: () =>
      assessInitialUpdateSnapshotCapacity({
        config: {},
        stateDir: f.stateDir,
        env: {},
      }),
    prepare: (config: OpenClawConfig = {}) => prepare(f, { config }),
    unchanged: async () => expect(await hashes()).toEqual(before),
  };
}

it.each([
  { space: 100, exitCode: 0, diagnostic: "" },
  { space: 70, exitCode: 1, diagnostic: "snapshot-capacity-insufficient" },
  { space: null, exitCode: 0, diagnostic: "free space unknown" },
])(
  "preflights one generation with $space MiB free (exit=$exitCode)",
  async ({ space, exitCode, diagnostic }) => {
    const f = await capacityFixture(space);
    const result = await f.assess();
    expect(result.exitCode, result.stderrTail ?? undefined).toBe(exitCode);
    if (diagnostic) {
      expect(result.stderrTail ?? result.diagnostics?.join("\n")).toContain(diagnostic);
    }
    await f.unchanged();
  },
);

it("copies and verifies both databases within the admitted capacity", async () => {
  const f = await capacityFixture(100, true);
  const rehearsal = await f.prepare();
  try {
    expect(rehearsal.snapshotCapacity.requiredBytes).toBeLessThan(100 * 1024 ** 2);
    for (const file of f.files) {
      const copy = path.join(rehearsal.stateDir, path.relative(f.stateDir, file));
      using db = openNodeSqliteDatabase(copy, { readOnly: true });
      expect(db.prepare("SELECT length(value) AS bytes FROM evidence").get()).toEqual({
        bytes: 8 * 1024 ** 2,
      });
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    }
  } finally {
    await rehearsal.cleanup();
  }
  await expect(fs.stat(rehearsal.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  await f.unchanged();
});

it("keeps the larger allowance when the candidate omits the copy capability", async () => {
  const f = await capacityFixture(100, true);
  const worker = path.join(f.root, "dist", "infra", "update-candidate-state.worker.js");
  // Exercise the real worker, but present the inventory contract of an older candidate.
  const source = await fs.readFile(worker, "utf8");
  await fs.writeFile(
    worker,
    `const originalWrite = process.stdout.write.bind(process.stdout);
     process.stdout.write = (chunk, ...args) => {
       const output = JSON.parse(String(chunk));
       delete output.snapshotSpace;
       return originalWrite(JSON.stringify(output), ...args);
     };
     ${source}`,
  );
  await expect(f.prepare()).rejects.toMatchObject(capacityFailure);
  await f.unchanged();
});

it.each(["global", "mixed-workboard", "global with SQLite built-in overrides"] as const)(
  "keeps the larger allowance for %s PostgreSQL portable exports",
  async (selection) => {
    const f = await capacityFixture(100, true);
    const database: OpenClawConfig["database"] =
      selection === "mixed-workboard"
        ? { families: { workboard: { engine: "postgres" } } }
        : { engine: "postgres" };
    if (selection === "global with SQLite built-in overrides") {
      database.families = Object.fromEntries(
        ["state", "agent", "workboard", "logbook", "team-reports"].map((family) => [
          family,
          { engine: "sqlite" } as const,
        ]),
      );
    }
    const rehearsal = f.prepare({
      database: {
        ...database,
        postgres: { connection: "postgresql://fixture:fixture@127.0.0.1:1/snapshot_fixture" },
      },
    });
    await rehearsal.then(
      async (result) => {
        await result.cleanup();
        expect.fail("Capacity preflight unexpectedly admitted a portable PostgreSQL export");
      },
      (error: unknown) => expect(error).toMatchObject(capacityFailure),
    );
    await f.unchanged();
  },
);

const { registerPolicyDoctorChecks } = await loadBundledPluginFacade<{
  registerPolicyDoctorChecks: (host: { registerHealthCheck: (check: HealthCheck) => void }) => void;
}>({ pluginId: "policy", artifactBasename: "api.ts" });

it.each(["token", "password"] as const)(
  "preserves 2026.10.5 config, state and policy for %s authentication",
  async (mode) => {
    const root = tempDirs.make("candidate-policy-");
    await materializeUpdateCandidateStateWorker(root);
    const policyPath = path.join(root, "policy.jsonc");
    await fs.writeFile(
      policyPath,
      JSON.stringify({
        gateway: { auth: { requireAuth: true, requireExplicitRateLimit: true } },
        dataHandling: { sensitiveLogging: { requireRedaction: true } },
        secrets: { allowInsecureProviders: true },
      }),
    );
    const user = "operator@example.invalid";
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          policy: {
            enabled: true,
            config: {
              path: policyPath,
              expectedAttestationHash:
                mode === "token"
                  ? "sha256:4fdc3e88ded7ecdfcdec09f8b30be01337df919cf9e51211e92a7a4d664ae545"
                  : "sha256:ede6e4f088dd6d2177dc3e8bbafcc80388a051381fc75301f01d42fef9d42218",
            },
          },
        },
      },
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          captureContent: true,
          headers: { Authorization: "synthetic-otel-secret", "X-Reference": "${OTEL_SECRET}" },
        },
      },
      gateway: {
        bind: "lan",
        port: 18789,
        auth: {
          mode,
          token: "synthetic-serving-token",
          password: { source: "env", provider: "default", id: "SYNTHETIC_SERVING_PASSWORD" },
          allowTailscale: true,
          rateLimit: { maxAttempts: 5, windowMs: 30_000, lockoutMs: 60_000, exemptLoopback: false },
          identityScopes: { [user]: ["operator.read"] },
          trustedProxy: { userHeader: "x-forwarded-user", allowUsers: [user] },
        },
        trustedProxies: ["192.0.2.1"],
      },
    };
    const original = structuredClone(config);
    const source = path.join(root, "source");
    const database = path.join(source, "agents/main/agent/openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(database), { recursive: true });
    {
      using db = openNodeSqliteDatabase(database);
      db.exec(OPENCLAW_AGENT_SCHEMA_V25_SQL);
      db.exec(`PRAGMA user_version = 25;
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'agent', 25, 'main', '2026.10.5', 1, 1);
        INSERT INTO cache_entries (scope, key, value_json, updated_at)
        VALUES ('fixture', 'retained', '{"keep":true}', 1);`);
    }
    const sourceBytes = await fs.readFile(database);
    const checks: HealthCheck[] = [];
    registerPolicyDoctorChecks({ registerHealthCheck: (check) => checks.push(check) });
    const lint = (cfg: OpenClawConfig, configPath: string) =>
      runDoctorLintChecks(
        { mode: "lint", cfg, configPath, cwd: root, runtime: { log() {}, error() {}, exit() {} } },
        { checks },
      );
    expect((await lint(config, path.join(root, "openclaw.json"))).findings).toEqual([]);

    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir: source,
      candidateRoot: root,
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-environment-token",
        OPENCLAW_GATEWAY_PASSWORD: "synthetic-environment-password",
      },
    });
    try {
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const result = await lint(copied, rehearsal.configPath);
      expect(result.findings).toEqual([]);
      expect(exitCodeFromFindings(result.findings)).toBe(0);
      expect(copied.gateway).toEqual({
        ...config.gateway,
        auth: { ...config.gateway?.auth, token: expect.any(String) },
      });
      expect(copied.gateway?.auth?.token).not.toBe(config.gateway?.auth?.token);
      expect(copied.diagnostics).toEqual({
        ...config.diagnostics,
        otel: {
          ...config.diagnostics?.otel,
          headers: { Authorization: expect.any(String), "X-Reference": "${OTEL_SECRET}" },
        },
      });
      expect(copied.diagnostics?.otel?.headers?.Authorization).not.toBe("synthetic-otel-secret");
      using db = openNodeSqliteDatabase(
        path.join(rehearsal.stateDir, path.relative(source, database)),
        { readOnly: true },
      );
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
      expect(
        db.prepare("SELECT value_json FROM cache_entries WHERE key = 'retained'").get(),
      ).toEqual({
        value_json: '{"keep":true}',
      });
      expect(await fs.readFile(database)).toEqual(sourceBytes);
      expect(rehearsal.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(rehearsal.env.OPENCLAW_GATEWAY_PASSWORD).toBeUndefined();
      expect(config).toEqual(original);
      const refused = new Error("cleanup authority retired");
      await expect(
        rehearsal.cleanup(() => {
          throw refused;
        }),
      ).rejects.toBe(refused);
      expect(await fs.readFile(rehearsal.configPath, "utf8")).toBeTruthy();
    } finally {
      const checked: string[] = [];
      await rehearsal.cleanup((directory) => {
        checked.push(directory);
      });
      expect(checked).toEqual([rehearsal.stateDir, ...rehearsal.cleanupDirectories]);
    }
  },
);

it("keeps workspace-confined avatars as valid as the serving config", async () => {
  const root = tempDirs.make("candidate-avatar-");
  await materializeUpdateCandidateStateWorker(root);
  const workspace = (id: string) => path.join(root, "workspaces", id);
  const avatar = (id: string, value: string) => ({
    workspace: workspace(id),
    identity: { avatar: value },
  });
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        main: avatar("main", `${workspace("main")}/a.png`),
        relative: avatar("relative", "avatars/a.png"),
        // Explicit local syntax must not be rewritten into a home or URI-like value.
        tilde: avatar("tilde", "./~a.png"),
        colon: avatar("colon", "./custom:a.png"),
        absoluteTilde: avatar("absoluteTilde", `${workspace("absoluteTilde")}/~a.png`),
        remote: { identity: { avatar: "https://example.invalid/a.png" } },
        escaped: avatar("escaped", `${root}/a.png`),
        // The candidate names workspaces by id, so ../<id> would land back inside it.
        renamed: avatar("other", `${workspace("renamed")}/a.png`),
        aliased: avatar("main", "../main/a.png"),
        climbed: avatar("climbed", "../../workspaces/climbed/a.png"),
        relativeRenamed: avatar("other", "../relativeRenamed/a.png"),
      },
    },
  };
  const issuePaths = (cfg: unknown) => {
    const result = validateConfigObject(cfg);
    return result.ok ? [] : result.issues.map((issue) => issue.path);
  };
  expect(issuePaths(config)).toEqual([
    "agents.entries.escaped.identity.avatar",
    "agents.entries.renamed.identity.avatar",
    "agents.entries.relativeRenamed.identity.avatar",
  ]);

  const rehearsal = await prepareUpdateCandidateRehearsal({
    config,
    stateDir: path.join(root, "source"),
    candidateRoot: root,
  });
  try {
    const copied: unknown = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
    expect(issuePaths(copied)).toEqual(issuePaths(config));
  } finally {
    await rehearsal.cleanup();
  }
});
