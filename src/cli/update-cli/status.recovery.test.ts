import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import * as marker from "../../infra/update-capture-privacy-marker.js";
import { createUpdateRunRecordFixture } from "../../infra/update-run-record.test-support.js";
import { updateStatusCommand as updateStatus } from "./status.js";
// Prepare the lazy production graph during collection, not inside the first test timeout.
import "../../infra/update-recovery-backup-status.js";

const mocks = vi.hoisted(() => ({
  readRun: vi.fn<typeof import("../../infra/update-run-reader.js").getUpdateRunAsync>(),
  log: vi.fn(),
  writeJson: vi.fn(),
}));
vi.mock("../../infra/update-run-reader.js", () => ({ getUpdateRunAsync: mocks.readRun }));
// Windows may canonicalize a recorded path's case or 8.3 spelling.
const pinSpelling = vi.hoisted(() => ({
  canonical: undefined as ((p: string) => string) | undefined,
}));
vi.mock("../../infra/directory-durability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/directory-durability.js")>();
  return {
    ...actual,
    pinDirectory: async (...args: Parameters<typeof actual.pinDirectory>) => {
      const pin = await actual.pinDirectory(...args);
      const canonical = pinSpelling.canonical;
      if (canonical) {
        Object.defineProperty(pin, "receipt", {
          value: { ...pin.receipt, realPath: canonical(pin.receipt.realPath) },
        });
      }
      return pin;
    },
  };
});
vi.mock("../../commands/node-runtime-diagnostics.js", () => ({
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../commands/doctor-session-sqlite-warnings.js", () => ({
  readSessionSqliteMigrationWarnings: () => [],
}));
vi.mock("../../infra/deferred-plugin-migrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/deferred-plugin-migrations.js")>()),
  readDeferredPluginMigrationsAsync: async () => [],
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
const printed = () => mocks.log.mock.calls.flat().join("\n");
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const markerFile = marker.UPDATE_CAPTURE_PRIVACY_MARKER;
const markCapture = (directory: string) =>
  fs.writeFile(path.join(directory, markerFile), marker.UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.readRun.mockReset().mockResolvedValue(undefined);
  root = tempDirs.make("update-status-recovery-");
  stateDir = path.join(root, "state");
  configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir);
  // Only the ledger is mocked; filesystem reads stay inside this fixture.
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
});
afterEach(() => vi.unstubAllEnvs());

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const text = (file: string) => fs.readFile(file, "utf8");
async function inspect() {
  await updateStatus({ json: true });
  return result();
}
async function capture(runId = firstId) {
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
    createdAt: "2026-09-10T00:00:00.000Z",
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
  await markCapture(directory);
  const raw = JSON.stringify(manifest);
  await fs.writeFile(manifestPath, raw);
  return { manifest, directory, manifestPath, raw, manifestSha256: digest(raw) };
}
type Capture = Awaited<ReturnType<typeof capture>>;
function result() {
  return mocks.writeJson.mock.lastCall?.[0];
}
async function readBaseline(c: Capture) {
  const { readUpdateRecoveryBaselineIdentity } =
    await import("../../infra/update-recovery-backup-reader.js");
  return readUpdateRecoveryBaselineIdentity({
    runId: c.manifest.runId,
    env: process.env,
    ref: { directory: c.directory, manifestPath: c.manifestPath, manifestSha256: c.manifestSha256 },
    installRoot: c.manifest.installRoot,
    readContinuation: () => undefined,
    assertCurrent: () => {},
  });
}
async function terminal(c: Capture, status: "committed" | "restored", sha = c.manifestSha256) {
  await writeJson(path.join(c.directory, "outcome.json"), { status, manifestSha256: sha });
}
async function run(c: Capture) {
  const { UpdateRunRecordSchema } = await import("../../infra/update-run-schema.js");
  return UpdateRunRecordSchema.parse(
    createUpdateRunRecordFixture(c.manifest.runId, {
      reason: "candidate-failed",
      origin: {
        updateRecoveryCapture: {
          manifestSha256: c.manifestSha256,
          configWrites: [],
          status: "pending",
        },
      },
    }),
  );
}

it("reports standalone Doctor captures as manual evidence", async () => {
  const c = await capture(`doctor-${firstId}`);
  await updateStatus({});
  const output = printed();
  expect(output).toContain(c.manifestPath);
  expect(output).toContain("No repair outcome is recorded");
  expect(output).not.toContain("no matching update run");
  expect(output).not.toContain("unresolved after a failed update");
  expect(await text(c.manifestPath)).toBe(c.raw);
  expect(new Set(await fs.readdir(c.directory))).toEqual(new Set([markerFile, "manifest.json"]));
});
it.each([
  ["partial", false],
  ["linked-manifest", true],
] as const)("keeps valid sets beside %s publication (JSON: %s)", async (publication, json) => {
  const c = await capture();
  await terminal(c, "committed");
  const directory = path.join(path.dirname(c.directory), secondId);
  await fs.mkdir(directory);
  await markCapture(directory);
  const store = path.dirname(directory);
  for (const name of [".DS_Store", "._capture", "Thumbs.db", "desktop.ini", "operator-notes.txt"]) {
    await fs.writeFile(path.join(store, name), "unrelated metadata");
  }
  // An unmarked directory is not a capture, even with a capture-like name or manifest.
  await fs.mkdir(path.join(store, "unmarked"));
  await fs.writeFile(path.join(store, "unmarked", "manifest.json"), "{");
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
  for (const { relativePath: name } of await listDirectoryTreeStrict(directory)) {
    const pathname = path.join(directory, name);
    if ((await fs.lstat(pathname)).isFile()) {
      retained.set(name, await fs.readFile(pathname));
    }
  }
  await updateStatus({ json });
  if (json) {
    expect(result()).not.toHaveProperty("recoverySetsError");
    expect(result().recoverySets).toMatchObject([
      { runId: c.manifest.runId, manifestPath: c.manifestPath, status: "stale" },
      { directory, status: "incomplete" },
    ]);
    const incomplete = result().recoverySets.find(
      (set: { status: string }) => set.status === "incomplete",
    );
    for (const field of ["ref", "manifestPath", "manifestSha256", "runId"]) {
      expect(incomplete).not.toHaveProperty(field);
    }
  } else {
    const output = printed();
    expect(output).toContain(c.manifestPath);
    expect(output).toContain(directory);
    expect(output).toContain("incomplete");
    expect(output).not.toContain("Update recovery sets unavailable");
  }
  expect(await text(c.manifestPath)).toBe(c.raw);
  for (const [name, bytes] of retained) {
    expect(await fs.readFile(path.join(directory, name))).toEqual(bytes);
  }
  if (publication === "linked-manifest") {
    const partial = await fs.lstat(partialPath, { bigint: true });
    expect(await fs.lstat(path.join(directory, "manifest.json"), { bigint: true })).toMatchObject({
      dev: partial.dev,
      ino: partial.ino,
      nlink: 2n,
    });
  }
});
it("refuses baseline reuse after an interrupted linked seal", async () => {
  const c = await capture();
  const partial = `${c.manifestPath}.partial`;
  await fs.link(c.manifestPath, partial);
  await expect(readBaseline(c)).rejects.toThrow("incomplete publication");
  expect(await Promise.all([text(partial), text(c.manifestPath)])).toEqual([c.raw, c.raw]);
});

it("reuses native spelling but refuses a linked capture", async () => {
  const c = await capture();
  pinSpelling.canonical = (realPath) => realPath.toUpperCase();
  try {
    await expect(readBaseline(c)).resolves.toMatchObject({
      ref: { directory: c.directory, manifestSha256: c.manifestSha256 },
    });
  } finally {
    pinSpelling.canonical = undefined;
  }
  const moved = `${c.directory}-moved`;
  await fs.rename(c.directory, moved);
  await fs.symlink(moved, c.directory, "dir");
  await expect(readBaseline(c)).rejects.toThrow(
    "Original update capture is not a retained directory",
  );
  expect(await text(path.join(moved, "manifest.json"))).toBe(c.raw);
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
    mocks.readRun.mockImplementation(async (id) => (id === c.manifest.runId ? row : undefined));
  }
  if (fault === "foreign-state") {
    await writeJson(c.manifestPath, { ...c.manifest, stateDir: path.join(root, "foreign") });
  }
  if (fault === "wrong-run-directory") {
    await fs.rename(c.directory, `${c.directory}-wrong`);
  }
  if (fault === "terminal-binding") {
    await terminal(c, "committed", "a".repeat(64));
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
  const healthy = await capture(secondId);
  await terminal(healthy, "committed");
  const directory = fault === "wrong-run-directory" ? `${c.directory}-wrong` : c.directory;
  const manifestPath = path.join(directory, "manifest.json");
  const retained = await text(manifestPath);
  await expect(updateStatus({ json: fault !== "malformed-text" })).resolves.toBeUndefined();
  if (fault === "malformed-text") {
    expect(printed()).toContain("Update capture: unreadable");
    expect(printed()).toContain(healthy.manifestPath);
    expect(printed()).toContain("Preserve this capture and current state");
    expect(printed()).not.toContain("Update recovery sets unavailable:");
  } else {
    expect(result()).toHaveProperty("availability");
    expect(result()).not.toHaveProperty("recoverySetsError");
    expect(result().recoverySets).toContainEqual(
      expect.objectContaining({ manifestPath: healthy.manifestPath, status: "stale" }),
    );
    const unreadable = result().recoverySets.find(
      (set: { status: string }) => set.status === "unreadable",
    );
    expect(unreadable).toMatchObject({ directory, message: expect.stringMatching(/[\s\S]/) });
    for (const field of ["ref", "manifestPath", "manifestSha256", "runId"]) {
      expect(unreadable).not.toHaveProperty(field);
    }
    if (fault === "durable-binding") {
      expect(unreadable.message).toContain("identity changed");
    }
  }
  expect(await text(manifestPath)).toBe(retained);
  expect(await text(healthy.manifestPath)).toBe(healthy.raw);
  if (malformed) {
    expect(await text(c.manifestPath)).toBe("{");
  }
});
it("keeps failed recovery ambiguous beside an unreadable marked capture", async () => {
  const c = await capture();
  const damaged = await capture(secondId);
  await fs.writeFile(damaged.manifestPath, "{");
  const row = await run(c);
  mocks.readRun.mockImplementation(async (id) => (id === firstId ? row : undefined));
  expect((await inspect()).recoverySets).toMatchObject([
    { runId: firstId, status: "ambiguous" },
    { directory: damaged.directory, status: "unreadable" },
  ]);
  expect(await text(damaged.manifestPath)).toBe("{");
});
it("reports a capture-root enumeration failure globally", async () => {
  const store = `${stateDir}.update-captures`;
  await fs.writeFile(store, "not a directory");
  const status = await inspect();
  expect(status.recoverySetsError).toMatch(/ENOTDIR|not a directory/i);
  expect(status).not.toHaveProperty("recoverySets");
  expect(await text(store)).toBe("not a directory");
});
it("reports one failed set as unresolved and multiple failed sets as ambiguous", async () => {
  const c = await capture();
  mocks.readRun.mockResolvedValue(await run(c));
  const unresolved = (await inspect()).recoverySets[0];
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
  const second = await capture(secondId);
  const rows = new Map([
    [c.manifest.runId, await run(c)],
    [second.manifest.runId, await run(second)],
  ]);
  mocks.readRun.mockImplementation(async (id) => rows.get(id));
  expect((await inspect()).recoverySets.map((s: { status: string }) => s.status)).toEqual([
    "ambiguous",
    "ambiguous",
  ]);
});
it("reports a set from a failure that never activated as stale and directs it to cleanup", async () => {
  const c = await capture();
  const failed = await run(c);
  const validated = [
    { step: "requested", status: "completed" },
    { step: "original-state-capture", status: "completed" },
    { step: "staging", status: "completed" },
    { step: "validating", status: "failed" },
  ] as const;
  mocks.readRun.mockResolvedValue({ ...failed, steps: [...validated] });
  const [set] = (await inspect()).recoverySets;
  expect(set).toMatchObject({ status: "stale", nextAction: "openclaw update cleanup" });
  expect(set.message).toContain("failed before changing the installation or state");
  expect(set.message).not.toMatch(/manual inspection/i);
  // An activation receipt keeps the same failed set as its manual recovery source.
  mocks.readRun.mockResolvedValue({
    ...failed,
    steps: [...validated, { step: "activating", status: "failed" }],
  });
  expect((await inspect()).recoverySets[0].status).toBe("unresolved");
});
it.each(["committed", "restored", "never-activated"] as const)(
  "does not let a %s capture obscure one failed recovery source",
  async (outcome) => {
    const failed = await capture();
    const older = await capture(secondId);
    const olderRun = await run(older);
    if (outcome === "never-activated") {
      olderRun.steps = [
        { step: "requested", status: "completed" },
        { step: "original-state-capture", status: "completed" },
        { step: "validating", status: "failed" },
      ];
    } else {
      await terminal(older, outcome);
    }
    const failedRun = await run(failed);
    mocks.readRun.mockImplementation(async (id) => (id === firstId ? failedRun : olderRun));
    const sets = (await inspect()).recoverySets;
    expect(sets.find((set: { runId: string }) => set.runId === firstId)).toMatchObject({
      status: "unresolved",
      nextAction: expect.stringContaining(failed.manifestPath),
      message: expect.stringContaining("Retained original state requires manual inspection"),
    });
    expect(sets.find((set: { runId: string }) => set.runId === secondId).status).toBe("stale");
    expect(await text(failed.manifestPath)).toBe(failed.raw);
    expect(await text(older.manifestPath)).toBe(older.raw);
  },
);
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
  expect((await inspect()).recoverySets[0]).toMatchObject({ status: "forward-resolved" });
  expect(new Set(await fs.readdir(c.directory))).toEqual(new Set([markerFile, "manifest.json"]));
  const candidate = {
    ...c.manifest,
    generation: { kind: "candidate", baselineSha256: c.manifestSha256 },
  };
  await fs.mkdir(path.join(c.directory, "candidate"));
  const raw = JSON.stringify(candidate);
  await fs.writeFile(path.join(c.directory, "candidate", "manifest.json"), raw);
  expect((await inspect()).recoverySets[0]).toMatchObject({
    status: "unreadable",
    message: expect.stringContaining("stale"),
  });
  row.origin.updateRecoveryCapture!.forwardResolution.binding.candidateSha256 = digest(raw);
  expect((await inspect()).recoverySets[0].status).toBe("forward-resolved");
  const partial = path.join(c.directory, "candidate", "manifest.json.partial");
  await fs.copyFile(path.join(c.directory, "candidate", "manifest.json"), partial);
  expect((await inspect()).recoverySets[0]).toMatchObject({
    status: "unreadable",
    message: expect.stringContaining("incomplete publication"),
  });
  expect(await text(partial)).toBe(raw);
  await fs.unlink(partial);
  await writeJson(path.join(c.directory, "candidate", "manifest.json"), {
    ...candidate,
    generation: { kind: "candidate", baselineSha256: "b".repeat(64) },
  });
  expect((await inspect()).recoverySets[0]).toMatchObject({
    status: "unreadable",
    message: expect.stringContaining("generation identity changed"),
  });
});
