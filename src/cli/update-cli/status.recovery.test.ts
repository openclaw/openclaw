import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../../infra/update-capture-privacy-marker.js";
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

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.readRun.mockReset();
  mocks.readRun.mockResolvedValue(undefined);
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
  await fs.writeFile(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
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
async function terminal(
  c: Capture,
  status: "committed" | "restored",
  manifestSha256 = c.manifestSha256,
) {
  await writeJson(path.join(c.directory, "outcome.json"), {
    status,
    manifestSha256,
  });
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
  expect(await fs.readdir(c.directory)).toEqual([UPDATE_CAPTURE_PRIVACY_MARKER, "manifest.json"]);
});
it.each([
  ["partial", false],
  ["linked-manifest", true],
] as const)("keeps valid sets beside %s publication (JSON: %s)", async (publication, json) => {
  const c = await capture();
  await terminal(c, "committed");
  const directory = path.join(path.dirname(c.directory), secondId);
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
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
  for (const name of (await listDirectoryTreeStrict(directory)).map(
    (walkEntry) => walkEntry.relativePath,
  )) {
    const pathname = path.join(directory, name);
    if ((await fs.lstat(pathname)).isFile()) {
      retained.set(name, await fs.readFile(pathname));
    }
  }
  await updateStatus({ json });
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
    mocks.readRun.mockResolvedValue(row);
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
  await expect(updateStatus({ json: fault !== "malformed-text" })).resolves.toBeUndefined();
  if (fault === "malformed-text") {
    expect(printed()).toContain("Update recovery sets unavailable:");
  } else {
    expect(result()).toHaveProperty("availability");
    expect(result()).not.toHaveProperty("recoverySets");
    expect(result()).toMatchObject({ recoverySetsError: expect.stringMatching(/[\s\S]/) });
    if (fault === "durable-binding") {
      expect(result().recoverySetsError).toContain("identity changed");
    }
  }
  if (malformed) {
    expect(await text(c.manifestPath)).toBe("{");
  }
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
  expect(await fs.readdir(c.directory)).toEqual([UPDATE_CAPTURE_PRIVACY_MARKER, "manifest.json"]);
  const candidate = {
    ...c.manifest,
    generation: { kind: "candidate", baselineSha256: c.manifestSha256 },
  };
  await fs.mkdir(path.join(c.directory, "candidate"));
  const raw = JSON.stringify(candidate);
  await fs.writeFile(path.join(c.directory, "candidate", "manifest.json"), raw);
  expect((await inspect()).recoverySetsError).toContain("stale");
  row.origin.updateRecoveryCapture!.forwardResolution.binding.candidateSha256 = digest(raw);
  expect((await inspect()).recoverySets[0].status).toBe("forward-resolved");
  const partial = path.join(c.directory, "candidate", "manifest.json.partial");
  await fs.copyFile(path.join(c.directory, "candidate", "manifest.json"), partial);
  expect((await inspect()).recoverySetsError).toContain("incomplete publication");
  expect(await text(partial)).toBe(raw);
  await fs.unlink(partial);
  await writeJson(path.join(c.directory, "candidate", "manifest.json"), {
    ...candidate,
    generation: { kind: "candidate", baselineSha256: "b".repeat(64) },
  });
  expect((await inspect()).recoverySetsError).toContain("generation identity changed");
});
