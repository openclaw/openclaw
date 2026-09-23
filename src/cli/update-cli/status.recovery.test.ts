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
vi.mock("../../infra/update-run-status.js", () => ({ readUpdateRunStatus: () => ({}) }));
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
  parseTimeoutMsOrExit: () => undefined,
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

it.each([true, false])(
  "reports retained sets from another installation through the real parser (JSON: %s)",
  async (json) => {
    const first = await capture("older", "2026-09-09T00:00:00.000Z"),
      second = await capture("newer");
    await terminal(first, "committed");
    await terminal(second, "restored");
    await updateStatusCommand({ json });
    if (json) {
      expect(result().recoverySets).toEqual(
        [second, first].map((c) => ({
          runId: c.manifest.runId,
          manifestPath: c.manifestPath,
          status: "stale",
          message: expect.stringContaining("stale:"),
          nextAction: "openclaw update status --json",
        })),
      );
    } else {
      const output = mocks.log.mock.calls.flat().join("\n");
      for (const c of [first, second]) {
        expect(output).toContain(c.manifestPath);
        expect(output).toContain(c.manifest.runId);
      }
      expect(output).toContain("stale");
      expect(output).toContain("Next action: openclaw update status --json");
    }
    expect(await fs.readFile(first.manifestPath, "utf8")).toBe(first.raw);
    expect(await fs.readdir(first.directory)).toEqual(["manifest.json", "outcome.json"]);
  },
);
it("reports an absent inventory explicitly without creating it", async () => {
  await updateStatusCommand({ json: true });
  expect(result().recoverySets).toEqual([]);
  expect(result()).not.toHaveProperty("recoverySetsError");
  await expect(fs.stat(`${stateDir}.update-captures`)).rejects.toMatchObject({ code: "ENOENT" });
});
it("distinguishes missing durable ownership from a safe recovery choice", async () => {
  const c = await capture();
  await updateStatusCommand({ json: true });
  expect(result().recoverySets[0]).toMatchObject({
    status: "ambiguous",
    message: expect.stringContaining("no matching update run"),
  });
  expect(await fs.readdir(c.directory)).toEqual(["manifest.json"]);
});
it.each([true, false])(
  "reports malformed manifests distinctly without hiding normal status (JSON: %s)",
  async (json) => {
    const c = await capture();
    await fs.writeFile(c.manifestPath, "{");
    await expect(updateStatusCommand({ json })).resolves.toBeUndefined();
    if (json) {
      expect(result()).toHaveProperty("availability");
      expect(result().recoverySetsError).toBeTypeOf("string");
      expect(result()).not.toHaveProperty("recoverySets");
    } else {
      expect(mocks.log.mock.calls.flat().join("\n")).toContain("Update recovery sets unavailable:");
    }
    expect(await fs.readFile(c.manifestPath, "utf8")).toBe("{");
  },
);
it.each([
  "config-inventory",
  "foreign-state",
  "wrong-run-directory",
  "terminal-binding",
  "incomplete-publication",
  "manifest-symlink",
  "manifest-hardlink",
  "canary-file",
  "archive-directory",
])("refuses %s through the production status reader", async (fault) => {
  const c = await capture();
  if (fault === "config-inventory") {
    await fs.writeFile(c.manifestPath, JSON.stringify({ ...c.manifest, configPaths: [] }));
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
  if (fault === "incomplete-publication") {
    await fs.unlink(c.manifestPath);
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
  if (fault === "canary-file") {
    await fs.writeFile(path.join(path.dirname(c.directory), "openclaw-update-canary-aB12cD"), "");
  }
  if (fault === "archive-directory") {
    await fs.mkdir(path.join(path.dirname(c.directory), "agent-schema-run-id.tar.gz"));
  }
  await updateStatusCommand({ json: true });
  expect(result()).not.toHaveProperty("recoverySets");
  expect(result().recoverySetsError).toBeTypeOf("string");
  expect(result().recoverySetsError.length).toBeGreaterThan(0);
});
it.each(["privacy-marker", "doctor-archive", "canary-directory"])(
  "keeps recovery sets visible beside a known %s without changing either artifact",
  async (artifact) => {
    const c = await capture();
    await terminal(c, "committed");
    const store = path.dirname(c.directory);
    const sibling = path.join(
      store,
      artifact === "privacy-marker"
        ? ".openclaw-private-update-capture"
        : artifact === "doctor-archive"
          ? `agent-schema-${c.manifest.runId}-22222222-2222-4222-8222-222222222222.tar.gz`
          : "openclaw-update-canary-aB12cD",
    );
    const contents =
      artifact === "privacy-marker"
        ? "openclaw-private-update-capture-v1\n"
        : "retained sibling bytes";
    if (artifact === "canary-directory") {
      await fs.mkdir(sibling);
    } else {
      await fs.writeFile(sibling, contents);
    }
    await updateStatusCommand({ json: true });
    expect(result()).not.toHaveProperty("recoverySetsError");
    expect(result().recoverySets).toEqual([
      expect.objectContaining({ runId: c.manifest.runId, status: "stale" }),
    ]);
    if (artifact === "canary-directory") {
      expect(await fs.readdir(sibling)).toEqual([]);
    } else {
      expect(await fs.readFile(sibling, "utf8")).toBe(contents);
    }
    expect(await fs.readFile(c.manifestPath, "utf8")).toBe(c.raw);
    // Recognized siblings must not hide genuinely incomplete captures.
    await fs.unlink(c.manifestPath);
    await updateStatusCommand({ json: true });
    expect(result().recoverySetsError).toContain("incomplete publication");
  },
);
it("still validates a manifest in a canary-named directory", async () => {
  const c = await capture("openclaw-update-canary-aB12cD");
  await fs.writeFile(c.manifestPath, "{");
  await updateStatusCommand({ json: true });
  expect(result()).not.toHaveProperty("recoverySets");
  expect(result().recoverySetsError).toBeTypeOf("string");
});

it("reports one failed set as unresolved and multiple failed sets as ambiguous", async () => {
  const c = await capture();
  mocks.readRun.mockResolvedValue(await run(c));
  await updateStatusCommand({ json: true });
  expect(result().recoverySets[0]).toMatchObject({
    status: "unresolved",
    nextAction: "npx openclaw@latest doctor --fix",
  });
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
it.each([false, true])(
  "never calls a changed durable manifest binding resolved (terminal: %s)",
  async (hasTerminal) => {
    const c = await capture();
    if (hasTerminal) {
      await terminal(c, "committed");
    }
    const row = await run(c);
    row.origin.updateRecoveryCapture!.manifestSha256 = "b".repeat(64);
    mocks.readRun.mockResolvedValue(row);
    await updateStatusCommand({ json: true });
    expect(result().recoverySetsError).toContain("identity changed");
  },
);
it("keeps contradictory terminal outcomes ambiguous", async () => {
  const c = await capture();
  await terminal(c, "restored");
  mocks.readRun.mockResolvedValue(await run(c, "succeeded"));
  await updateStatusCommand({ json: true });
  expect(result().recoverySets[0]).toMatchObject({
    status: "ambiguous",
    message: expect.stringContaining("outcomes disagree"),
  });
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
