import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { updateStatusCommand } from "./status.js";
// Prepare the lazy production graph during collection, not inside the first test timeout.
import "../../infra/update-recovery-backup-status.js";

const mocks = vi.hoisted(() => ({
  readRun: vi.fn<typeof import("../../infra/update-run-reader.js").getUpdateRunAsync>(),
  log: vi.fn(),
  writeJson: vi.fn(),
}));
vi.mock("../../infra/update-run-reader.js", () => ({ getUpdateRunAsync: mocks.readRun }));
vi.mock("../../commands/node-runtime-diagnostics.js", () => ({
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../commands/doctor-session-sqlite-warnings.js", () => ({
  readSessionSqliteMigrationWarnings: () => [],
}));
vi.mock("../../infra/deferred-plugin-migrations.js", () => ({
  readDeferredPluginMigrations: () => [],
  formatDeferredPluginMigration: () => "",
}));
vi.mock("../../config/config.js", () => ({
  readSourceConfigBestEffort: async () => ({ gateway: { mode: "remote" } }),
}));
vi.mock("../../infra/update-run-status.js", () => ({ readUpdateRunStatus: async () => ({}) }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks }));
vi.mock("../../gateway/call.js", () => ({ callGateway: async () => ({}) }));
vi.mock("../../infra/channels-status-issues.js", () => ({ collectChannelStatusIssues: () => [] }));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => {
    throw new Error("Unexpected service access");
  },
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/new-cli",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.3" },
  }),
  formatGitInstallLabel: () => undefined,
}));
vi.mock("./shared.js", () => ({
  resolveUpdateRoot: async () => "/fixture/new-cli",
  parseUpdateTimeoutMs: () => undefined,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let stateDir: string;
let configPath: string;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.readRun.mockReset();
  mocks.readRun.mockResolvedValue(undefined);
  root = tempDirs.make("update-status-recovery-");
  stateDir = path.join(root, "state");
  configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir);
  // All real filesystem reads resolve inside this physical fixture. The ledger
  // reader is mocked; this suite must never open an actual state/handoff database.
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
});
afterEach(() => vi.unstubAllEnvs());

async function capture(
  runId = "11111111-1111-4111-8111-111111111111",
  createdAt = "2026-09-10T00:00:00.000Z",
) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const manifest = {
    schemaVersion: 2,
    kind: "update-recovery",
    generation: { kind: "baseline" },
    databases: [{ path: databasePath, role: "global" }],
    runId,
    installRoot: path.join(root, "older-install"),
    stateDir,
    configPath,
    configPaths: [configPath],
    creator: { host: "fixture", pid: 1, startIdentity: "1" },
    drivers: [],
    createdAt,
    roots: [stateDir],
    excludedRoots: [],
    protectedPaths: [configPath],
    entries: [
      { kind: "directory", sourcePath: stateDir, mode: 0o700 },
      { kind: "missing", sourcePath: configPath, sqlite: false, directory: false },
      { kind: "missing", sourcePath: databasePath, sqlite: true, directory: false },
    ],
  };
  const directory = `${stateDir}.update-captures/${runId}`;
  const manifestPath = path.join(directory, "manifest.json");
  await fs.mkdir(directory, { recursive: true });
  const raw = JSON.stringify(manifest);
  await fs.writeFile(manifestPath, raw);
  return { manifest, directory, manifestPath, raw, manifestSha256: digest(raw) };
}
function result() {
  return mocks.writeJson.mock.lastCall?.[0];
}
async function terminal(c: Awaited<ReturnType<typeof capture>>, status: "committed" | "restored") {
  await fs.writeFile(
    path.join(c.directory, "outcome.json"),
    JSON.stringify({ status, manifestSha256: c.manifestSha256 }),
  );
}
function run(c: Awaited<ReturnType<typeof capture>>, status = "failed") {
  // Build through the production schema, not a widened cast of partial ledger state.
  return import("../../infra/update-run-schema.js").then(({ UpdateRunRecordSchema }) =>
    UpdateRunRecordSchema.parse({
      runId: c.manifest.runId,
      trigger: "cli",
      status,
      phase: "finished",
      createdAtMs: 1,
      updatedAtMs: 2,
      finishedAtMs: 2,
      confirmedAtMs: null,
      downtimeMs: null,
      reason: status === "failed" ? "candidate-failed" : null,
      origin: {
        updateRecoveryCapture: {
          manifestSha256: c.manifestSha256,
          configWrites: [],
          status: "pending",
        },
      },
      target: {},
      before: {},
      after: {},
      steps: [],
      verification: {},
      repair: [],
    }),
  );
}

it("reports standalone Doctor captures as manual evidence", async () => {
  const c = await capture("doctor-11111111-1111-4111-8111-111111111111");
  await updateStatusCommand({});
  const output = mocks.log.mock.calls.flat().join("\n");
  expect(output).toContain(c.manifestPath);
  expect(output).toContain("No repair outcome is recorded");
  expect(output).not.toContain("no matching update run");
  expect(output).not.toContain("unresolved after a failed update");
  expect(await fs.readFile(c.manifestPath, "utf8")).toBe(c.raw);
  expect(await fs.readdir(c.directory)).toEqual(["manifest.json"]);
});
it.each([
  ["partial", false],
  ["linked-manifest", true],
] as const)(
  "keeps valid recovery sets visible beside an interrupted %s publication (JSON: %s)",
  async (publication, json) => {
    const c = await capture();
    await terminal(c, "committed");
    const directory = path.join(path.dirname(c.directory), "22222222-2222-4222-8222-222222222222");
    await fs.mkdir(directory);
    const partialPath = path.join(directory, "manifest.json.partial");
    await fs.writeFile(
      partialPath,
      publication === "partial"
        ? '{"schemaVersion":2'
        : JSON.stringify({ ...c.manifest, runId: path.basename(directory) }),
    );
    if (publication === "linked-manifest") {
      await fs.link(partialPath, path.join(directory, "manifest.json"));
    }
    const retained = new Map<string, Buffer>();
    for (const name of await fs.readdir(directory, { recursive: true })) {
      const pathname = path.join(directory, name);
      if ((await fs.lstat(pathname)).isFile()) {
        retained.set(name, await fs.readFile(pathname));
      }
    }
    await updateStatusCommand({ json });
    if (json) {
      expect(result()).not.toHaveProperty("recoverySetsError");
      expect(result().recoverySets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: c.manifest.runId,
            manifestPath: c.manifestPath,
            status: "stale",
          }),
          expect.objectContaining({ directory, status: "incomplete" }),
        ]),
      );
      expect(result().recoverySets).toHaveLength(2);
      const incomplete = result().recoverySets.find(
        (set: { status: string }) => set.status === "incomplete",
      );
      for (const field of ["ref", "manifestPath", "manifestSha256", "runId"]) {
        expect(incomplete).not.toHaveProperty(field);
      }
    } else {
      const output = mocks.log.mock.calls.flat().join("\n");
      expect(output).toContain(c.manifestPath);
      expect(output).toContain(directory);
      expect(output).toContain("incomplete");
      expect(output).not.toContain("Update recovery sets unavailable");
    }
    expect(await fs.readFile(c.manifestPath, "utf8")).toBe(c.raw);
    for (const [name, bytes] of retained) {
      expect(await fs.readFile(path.join(directory, name))).toEqual(bytes);
    }
    if (publication === "linked-manifest") {
      const partial = await fs.lstat(partialPath, { bigint: true });
      expect(await fs.lstat(path.join(directory, "manifest.json"), { bigint: true })).toMatchObject(
        {
          dev: partial.dev,
          ino: partial.ino,
          nlink: 2n,
        },
      );
    }
  },
);
it("refuses baseline reuse after an interrupted linked seal", async () => {
  const c = await capture();
  const partial = `${c.manifestPath}.partial`;
  await fs.link(c.manifestPath, partial);
  const { readUpdateRecoveryBaselineIdentity } =
    await import("../../infra/update-recovery-backup-reader.js");
  await expect(
    readUpdateRecoveryBaselineIdentity({
      runId: c.manifest.runId,
      env: process.env,
      ref: {
        directory: c.directory,
        manifestPath: c.manifestPath,
        manifestSha256: c.manifestSha256,
      },
      installRoot: c.manifest.installRoot,
      readContinuation: () => undefined,
      assertCurrent: () => {},
    }),
  ).rejects.toThrow("incomplete publication");
  expect(await fs.readFile(partial, "utf8")).toBe(c.raw);
  expect(await fs.readFile(c.manifestPath, "utf8")).toBe(c.raw);
});

it.each([
  "foreign-state",
  "wrong-run-directory",
  "terminal-binding",
  "manifest-symlink",
  "manifest-hardlink",
  "malformed-text",
  "canary-manifest",
  "durable-binding",
])("refuses %s without hiding normal status", async (fault) => {
  const c = await capture(
    fault === "canary-manifest" ? "openclaw-update-canary-aB12cD" : undefined,
  );
  const malformed = fault.startsWith("malformed-") || fault === "canary-manifest";
  if (malformed) {
    await fs.writeFile(c.manifestPath, "{");
  }
  if (fault === "durable-binding") {
    await terminal(c, "committed");
    const row = await run(c);
    row.origin.updateRecoveryCapture!.manifestSha256 = "b".repeat(64);
    mocks.readRun.mockResolvedValue(row);
  }
  if (fault === "foreign-state") {
    await fs.writeFile(
      c.manifestPath,
      JSON.stringify({ ...c.manifest, stateDir: path.join(root, "foreign") }),
    );
  }
  if (fault === "wrong-run-directory") {
    await fs.rename(c.directory, `${c.directory}-wrong`);
  }
  if (fault === "terminal-binding") {
    await fs.writeFile(
      path.join(c.directory, "outcome.json"),
      JSON.stringify({ status: "committed", manifestSha256: "a".repeat(64) }),
    );
  }
  if (fault === "manifest-symlink" || fault === "manifest-hardlink") {
    const target = path.join(root, "manifest-target.json");
    await fs.rename(c.manifestPath, target);
    if (fault === "manifest-symlink") {
      await fs.symlink(target, c.manifestPath);
    } else {
      await fs.link(target, c.manifestPath);
    }
  }
  await expect(updateStatusCommand({ json: fault !== "malformed-text" })).resolves.toBeUndefined();
  if (fault === "malformed-text") {
    expect(mocks.log.mock.calls.flat().join("\n")).toContain("Update recovery sets unavailable:");
  } else {
    expect(result()).toHaveProperty("availability");
    expect(result()).not.toHaveProperty("recoverySets");
    expect(result().recoverySetsError).toBeTypeOf("string");
    expect(result().recoverySetsError.length).toBeGreaterThan(0);
    if (fault === "durable-binding") {
      expect(result().recoverySetsError).toContain("identity changed");
    }
  }
  if (malformed) {
    expect(await fs.readFile(c.manifestPath, "utf8")).toBe("{");
  }
});
it("reports one failed set as unresolved and multiple failed sets as ambiguous", async () => {
  const c = await capture();
  mocks.readRun.mockResolvedValue(await run(c));
  await updateStatusCommand({ json: true });
  const unresolved = result().recoverySets[0];
  expect(unresolved.status).toBe("unresolved");
  expect(unresolved.nextAction).toContain(c.manifestPath);
  expect(unresolved.nextAction).toMatch(/preserve current state/i);
  expect(unresolved.nextAction).toContain(
    "https://docs.openclaw.ai/cli/update/repair-and-recovery#original-state-captures",
  );
  expect(unresolved.message).toMatch(/retained original.*manual inspection/i);
  for (const guidance of [unresolved.nextAction, unresolved.message]) {
    expect(guidance).not.toContain("openclaw update status --json");
    expect(guidance).not.toContain("doctor --fix");
  }
  const second = await capture("22222222-2222-4222-8222-222222222222");
  const rows = new Map([
    [c.manifest.runId, await run(c)],
    [second.manifest.runId, await run(second)],
  ]);
  mocks.readRun.mockImplementation(async (id) => rows.get(id));
  await updateStatusCommand({ json: true });
  expect(result().recoverySets.map((s: { status: string }) => s.status)).toEqual([
    "ambiguous",
    "ambiguous",
  ]);
});
it("validates forward resolution against retained generations without writing", async () => {
  const c = await capture();
  const row = await run(c);
  row.origin.updateRecoveryCapture!.forwardResolution = {
    kind: "forward-resolved",
    completedAtMs: 3,
    binding: {
      runId: c.manifest.runId,
      failedAtMs: 2,
      manifestSha256: c.manifestSha256,
      candidateSha256: null,
      preparedSha256: null,
      installRoot: c.manifest.installRoot,
      stateDir,
      configPath,
    },
    repair: {
      root: "/fixture/repair",
      packageSha256: "a".repeat(64),
      node: "/fixture/node",
      nodeVersion: "v24.0.0",
      build: "fixture",
      artifact: {
        rootIdentity: "1:2",
        module: "doctor.js",
        entry: "openclaw.mjs",
        inventorySha256: "b".repeat(64),
        executableIdentity: "1:3",
        executableSha256: "c".repeat(64),
      },
    },
  };
  mocks.readRun.mockResolvedValue(row);
  await updateStatusCommand({ json: true });
  expect(result().recoverySets[0]).toMatchObject({ status: "forward-resolved" });
  expect(await fs.readdir(c.directory)).toEqual(["manifest.json"]);
  const candidate = {
    ...c.manifest,
    generation: { kind: "candidate", baselineSha256: c.manifestSha256 },
  };
  await fs.mkdir(path.join(c.directory, "candidate"));
  const raw = JSON.stringify(candidate);
  await fs.writeFile(path.join(c.directory, "candidate", "manifest.json"), raw);
  await updateStatusCommand({ json: true });
  expect(result().recoverySetsError).toContain("stale");
  row.origin.updateRecoveryCapture!.forwardResolution.binding.candidateSha256 = digest(raw);
  await updateStatusCommand({ json: true });
  expect(result().recoverySets[0].status).toBe("forward-resolved");
  const partial = path.join(c.directory, "candidate", "manifest.json.partial");
  await fs.copyFile(path.join(c.directory, "candidate", "manifest.json"), partial);
  await updateStatusCommand({ json: true });
  expect(result().recoverySetsError).toContain("incomplete publication");
  expect(await fs.readFile(partial, "utf8")).toBe(raw);
  await fs.unlink(partial);
  await fs.writeFile(
    path.join(c.directory, "candidate", "manifest.json"),
    JSON.stringify({
      ...candidate,
      generation: { kind: "candidate", baselineSha256: "b".repeat(64) },
    }),
  );
  await updateStatusCommand({ json: true });
  expect(result().recoverySetsError).toContain("generation identity changed");
});
