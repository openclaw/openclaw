import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as sqliteImport from "../config/sessions/session-accessor.sqlite-import.js";
import { prepareGithubIssue } from "../infra/github-issue.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import {
  claimSessionSqliteMigrationGithubIssue as claimIssue,
  clearSessionSqliteMigrationGithubIssueClaim as clearClaim,
  createSessionSqliteMigrationFailureIssue as createIssue,
  writeSessionSqliteMigrationFailureReports as writeReports,
} from "./doctor-session-sqlite-failure.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  canonicalTestPaths,
  type TestStore,
  type SessionSqliteMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();
const failureTime = "2030-01-01T00:00:00.000Z";

function failureTarget(
  store: TestStore,
  overrides: Partial<SessionSqliteMigrationManifest["targets"][number]> = {},
) {
  return {
    ...trustedMigrationTarget(store),
    completedMoves: [],
    issues: [{ code: "startup_failure", message: "sanitized failure" }],
    plannedMoves: [],
    validationBeforeArchive: "failed" as const,
    ...overrides,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function preparedIssue(file: string) {
  return prepareGithubIssue(expectDefined(createIssue(file), "saved failure report"));
}

function expectPrivate(text: string | undefined, values: string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

function failureManifest(
  store: TestStore,
  runId: string,
  overrides: Partial<SessionSqliteMigrationManifest> = {},
): SessionSqliteMigrationManifest {
  return {
    failedAt: failureTime,
    manifestVersion: 3,
    openClawVersion: "test",
    runId,
    startedAt: failureTime,
    targets: [failureTarget(store)],
    ...overrides,
  };
}

it.each([false, true])("records import rejection (journal failure=%s)", async (journalFailure) => {
  const store = createLegacyStore();
  const failure = "attempt to write a readonly database";
  const importError = new Error(failure);
  const recordError = new Error("fixture migration journal write failed");
  {
    using importSpy = vi.spyOn(sqliteImport, "importSqliteSessionRowsBatch");
    importSpy.mockRejectedValueOnce(importError);
    using journalSpy = journalFailure
      ? vi.spyOn(migrationRun, "updateMigrationManifestTarget")
      : undefined;
    journalSpy?.mockImplementationOnce(() => {
      throw recordError;
    });
    const imported = importLegacyStore(store);
    if (journalFailure) {
      await expect(imported).rejects.toMatchObject({
        cause: importError,
        errors: [importError, recordError],
        message: `${failure}; could not record session SQLite migration failure: ${recordError.message}`,
      });
    } else {
      await expect(imported).rejects.toBe(importError);
    }
  }
  expect(fs.existsSync(store.transcriptPath)).toBe(true);
  if (journalFailure) {
    return;
  }
  const manifests = migrationRun.listSessionSqliteMigrationManifestPaths(store.env);
  expect(manifests).toHaveLength(1);
  const manifestPath = requireMigrationManifestPath(manifests[0]);
  const manifest = readMigrationManifest(manifestPath);
  expect(manifest.failedAt).toEqual(expect.any(String));
  expect(manifest.targets[0]?.issues).toContainEqual({
    code: "sqlite_import_failed",
    message: failure,
  });
  expect(manifest.targets[0]?.completedMoves).toEqual([]);
  expect(manifest.completedAt).toBeUndefined();
  const recovered = await runDoctorSessionSqlite({ cfg: {}, env: store.env, mode: "recover" });
  expect(recovered.supportIssue?.body).toContain(`[sqlite_import_failed] ${failure}`);
  expect(recovered.supportIssue?.body).toContain(`- Failed: ${manifest.failedAt}`);
});

it.each([false, true])(
  "recovers latest matching failure (explicit store=%s)",
  async (explicitStore) => {
    const store = createLegacyStore(explicitStore ? {} : { agentDirName: "token=supersecret" });
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      {
        code: "startup_failure",
        message: explicitStore
          ? "selected store failed after archive"
          : `token=supersecret startup migration failed for agent:main:main at ${store.storePath} and ${process.env.HOME ?? "/Users/example"}/private/openclaw.json`,
        ...(explicitStore ? {} : { sessionKey: "agent:main:main" }),
      },
    ];
    if (explicitStore) {
      manifest.targets.push(
        failureTarget(store, {
          agentId: "other",
          issues: [
            { code: "unselected_failure", message: "unselected target should stay private" },
          ],
          sqlitePath: path.join(store.tempDir, "other.sqlite"),
          storePath: path.join(store.tempDir, "other", "sessions.json"),
        }),
      );
      writeFailedManifest(store, "newer-unselected.json", "2040-01-01T00:00:00.000Z", {
        agentId: "other",
        storePath: path.join(store.tempDir, "other", "sessions.json"),
      });
    } else {
      writeFailedManifest(store, "older-failed.json", "2000-01-01T00:00:00.000Z");
    }
    writeJson(manifestPath, manifest);
    const conflictingTranscript =
      '{"type":"session","sessionId":"session-1"}\n' +
      '{"type":"event","id":"evt-1","text":"conflicting legacy event"}\n';
    if (!explicitStore) {
      fs.writeFileSync(store.transcriptPath, conflictingTranscript, { mode: 0o600 });
    }

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
      ...(explicitStore ? { store: store.storePath } : {}),
    });

    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    if (explicitStore) {
      expect(recover.supportIssue).toBeUndefined();
      expect(recover.totals.issues).toBe(0);
      expect(fs.existsSync(store.transcriptPath)).toBe(false);
      return;
    }
    expect(recover.mode).toBe("recover");
    expect(recover.totals).not.toHaveProperty("archivedLegacyStoreFiles");
    expect(recover.totals).not.toHaveProperty("reclaimedBytes");
    expect(recover.targets[0]?.issues.map((issue) => issue.code)).toEqual([
      "active_sqlite_transcript_verification_failed",
      "sqlite_transcript_count_mismatch",
      "active_sqlite_transcript_jsonl",
      "restore_conflict",
    ]);
    expect(recover.targets[0]?.issues[0]).toMatchObject({
      sessionKey: "agent:main:main",
      message: expect.stringContaining("Legacy event evt-1 conflicts with the SQLite event"),
    });
    expect(recover.targets[0]?.restore?.restoredFiles).toEqual(
      expect.arrayContaining(canonicalTestPaths([store.trajectoryPath])),
    );
    expect(recover.targets[0]?.restore?.conflicts).toEqual([
      expect.objectContaining({ sourcePath: canonicalTestPaths([store.transcriptPath])[0] }),
    ]);
    expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe(conflictingTranscript);
    expect(recover.supportIssue?.title).toContain(manifest.runId);
    for (const text of ["startup_failure", "restore_conflict", `- Failed: ${manifest.failedAt}`]) {
      expect(recover.supportIssue?.body).toContain(text);
    }
    expectPrivate(recover.supportIssue?.body, [
      "agent:main:main",
      "supersecret",
      "conflicting legacy event",
      store.storePath,
      ...(process.env.HOME ? [process.env.HOME] : []),
    ]);
    expect(recover.supportIssue).not.toHaveProperty("url");
  },
);

it.each(["empty-report", "restored", "completed"] as const)(
  "omits support reports for clean recovery (%s)",
  async (evidence) => {
    const store = createLegacyStore();
    for (const file of [
      store.storePath,
      store.transcriptPath,
      store.trajectoryPath,
      store.unreferencedJsonlPath,
    ]) {
      fs.rmSync(file);
    }
    const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(runsDir, "clean-recovery.json");
    const manifest = failureManifest(
      store,
      "clean-recovery",
      evidence === "completed" ? { completedAt: failureTime, failedAt: undefined } : {},
    );
    const target = manifest.targets[0]!;
    target.validationBeforeArchive = "not_run";
    target.issues = [];
    if (evidence === "restored") {
      const archiveDir = path.join(store.stateDir, "agents/main/session-sqlite-import-archive");
      const archivePath = path.join(archiveDir, "legacy-store.sessions.json.imported-1");
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, "{}\n");
      const move = { archivePath, kind: "legacy-store" as const, sourcePath: target.storePath };
      target.plannedMoves.push(move);
      target.completedMoves.push(move);
    }
    writeJson(manifestPath, manifest);
    const previousReports =
      evidence === "empty-report"
        ? writeReports(manifestPath, { reason: "Earlier recovery" })
        : undefined;
    const previousBytes = previousReports
      ? [previousReports.jsonPath, previousReports.markdownPath].map((file) =>
          fs.readFileSync(file),
        )
      : undefined;
    const recover = await runDoctorSessionSqlite({ cfg: {}, env: store.env, mode: "recover" });
    expect(recover.totals.issues).toBe(0);
    if (evidence === "restored") {
      expect(recover.targets[0]?.restore?.restoredFiles).toEqual([target.storePath]);
    }
    expect(recover.migrationRun).toEqual(
      evidence === "completed" ? undefined : { manifestPath, runId: "clean-recovery" },
    );
    expect(recover.supportIssue).toBeUndefined();
    expect(readMigrationManifest(manifestPath).targets[0]?.issues).toEqual(target.issues);
    if (previousReports && previousBytes) {
      expect(fs.readFileSync(previousReports.jsonPath)).toEqual(previousBytes[0]);
      expect(fs.readFileSync(previousReports.markdownPath)).toEqual(previousBytes[1]);
    } else {
      expect(fs.existsSync(manifestPath.replace(/\.json$/u, ".failure.json"))).toBe(false);
      expect(fs.existsSync(manifestPath.replace(/\.json$/u, ".failure.md"))).toBe(false);
    }
  },
);

it.each(["replaced", "missing"] as const)("rechecks saved support consent (%s)", (change) => {
  const store = createLegacyStore();
  writeFailedManifest(store, "consent-race.json", "2030-01-01T00:00:00.000Z");
  const manifestPath = path.join(store.stateDir, "session-sqlite-migration-runs/consent-race.json");
  const { markdownPath } = writeReports(manifestPath, { reason: "recovery before consent" });
  const approved = preparedIssue(manifestPath);
  if (change === "replaced") {
    writeReports(manifestPath, { reason: "another recovery during consent" });
  } else {
    fs.unlinkSync(markdownPath);
  }
  const manifestBefore = fs.readFileSync(manifestPath);

  expect(claimIssue(manifestPath, approved, { assertCurrent: vi.fn() })).toBeUndefined();
  expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
  if (change === "missing") {
    expect(createIssue(manifestPath)).toBeUndefined();
    expect(fs.existsSync(markdownPath)).toBe(false);
    return;
  }

  const current = preparedIssue(manifestPath);
  expect(current.marker).not.toBe(approved.marker);
  expect(claimIssue(manifestPath, current, { assertCurrent: vi.fn() })).toMatchObject({
    issue: { marker: current.marker },
    status: "claimed",
  });
  expect(readMigrationManifest(manifestPath).failureReports?.githubIssue?.marker).toBe(
    current.marker,
  );
});

it("persists one support issue receipt on a historical v3 manifest", () => {
  const store = createLegacyStore();
  const manifestPath = path.join(store.tempDir, "historical-v3.json");
  const failureJsonPath = manifestPath.replace(/\.json$/u, ".failure.json");
  const failureMarkdownPath = manifestPath.replace(/\.json$/u, ".failure.md");
  const manifest = failureManifest(store, "historical-v3", {
    failureReports: { jsonPath: failureJsonPath, markdownPath: failureMarkdownPath },
    manifestVersion: 3,
    openClawVersion: "historical",
  });
  writeJson(manifestPath, manifest);
  const authority = { assertCurrent: vi.fn() };
  const savedReport = "stable sanitized report v3\n";
  fs.writeFileSync(failureMarkdownPath, savedReport, { mode: 0o600 });
  const { marker, title } = preparedIssue(manifestPath);
  const issue = { marker, title };

  const receipt = { ...issue, status: "attempted" };
  expect(claimIssue(manifestPath, issue, authority)).toMatchObject({
    issue: receipt,
    status: "claimed",
  });
  const claim = (candidate: typeof issue) => claimIssue(manifestPath, candidate, authority);
  expect(claim({ ...issue, title: "regenerated title must not replace the claim" })).toMatchObject({
    issue: receipt,
    status: "existing",
  });

  writeReports(manifestPath, { reason: "retry" });
  expect(createIssue(manifestPath)).toMatchObject({
    body: expect.stringContaining(savedReport.trimEnd()),
    title: issue.title,
  });
  const receiptManifest = readMigrationManifest(manifestPath);
  expect(receiptManifest).toMatchObject({
    failureReports: { githubIssue: receipt },
    manifestVersion: 4,
  });
  writeJson(manifestPath, { ...receiptManifest, manifestVersion: 3 });
  expect(migrationRun.readSessionSqliteMigrationManifest(manifestPath)).toBeUndefined();
  writeJson(manifestPath, receiptManifest);
  expect(
    claim({
      marker: `openclaw-report:${"c".repeat(64)}`,
      title: "regenerated process must not replace the claim",
    }),
  ).toMatchObject({ issue: receipt, status: "existing" });
  const receiptJson = fs.readFileSync(manifestPath, "utf8");
  expectPrivate(receiptJson, [
    savedReport.trimEnd(),
    "github.com/openclaw/openclaw/issues/",
    "openclaw doctor",
    '"body"',
    "?body=",
  ]);
  expect(fs.readFileSync(failureMarkdownPath, "utf8")).toBe(savedReport);
  expect(clearClaim(manifestPath, issue.marker, authority)).toBe(true);
  const clearedManifest = readMigrationManifest(manifestPath);
  expect(clearedManifest.manifestVersion).toBe(4);
  expect(clearedManifest.failureReports).not.toHaveProperty("githubIssue");
  expect(authority.assertCurrent).toHaveBeenCalledTimes(4);
});

it("derives private report paths instead of trusting persisted destinations", () => {
  const store = createLegacyStore();
  const manifestPath = path.join(store.tempDir, "path-ownership.json");
  const expectedJsonPath = path.join(store.tempDir, "path-ownership.failure.json");
  const expectedMarkdownPath = path.join(store.tempDir, "path-ownership.failure.md");
  const untrustedJsonPath = path.join(store.tempDir, "untrusted-destination.json");
  const untrustedMarkdownPath = path.join(store.tempDir, "untrusted-destination.md");
  const manifest = failureManifest(store, "path-ownership", {
    failureReports: { jsonPath: untrustedJsonPath, markdownPath: untrustedMarkdownPath },
  });
  writeJson(manifestPath, manifest);
  fs.writeFileSync(untrustedJsonPath, "private json sentinel\n", { mode: 0o600 });
  fs.writeFileSync(untrustedMarkdownPath, "private markdown sentinel\n", { mode: 0o600 });

  const expectedPaths = { jsonPath: expectedJsonPath, markdownPath: expectedMarkdownPath };
  expect(writeReports(manifestPath, { reason: "failed" })).toEqual(expectedPaths);
  expect(createIssue(manifestPath)).toMatchObject({
    body: expect.not.stringContaining("private markdown sentinel"),
    bodyPath: expectedMarkdownPath,
  });
  expect(fs.readFileSync(untrustedJsonPath, "utf8")).toBe("private json sentinel\n");
  expect(fs.readFileSync(untrustedMarkdownPath, "utf8")).toBe("private markdown sentinel\n");
  expect(readMigrationManifest(manifestPath).failureReports).toEqual(expectedPaths);
});

it("keeps bounded GitHub issue bodies on a valid UTF-16 boundary", () => {
  const store = createLegacyStore();
  const manifestPath = path.join(store.tempDir, "failed-migration.json");
  const unpairedSurrogate =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  const render = (messages: string[]) => {
    const manifest = failureManifest(store, "utf16-boundary", {
      manifestVersion: 2,
      targets: Array.from({ length: Math.ceil(messages.length / 10) }, (_, index) =>
        failureTarget(store, {
          agentId: `agent-${index}`,
          issues: messages
            .slice(index * 10, (index + 1) * 10)
            .map((message) => ({ code: "startup_failure", message })),
          sqlitePath: path.join(store.tempDir, "openclaw-agent.sqlite"),
        }),
      ),
    });
    writeJson(manifestPath, manifest);
    return createIssue(manifestPath);
  };

  const fieldIssue = render([`${"x".repeat(499)}🎉tail`]);
  expect(fieldIssue?.body).toContain(`${"x".repeat(499)}\n`);
  expect(fieldIssue?.body).not.toContain("🎉tail");
  expect(fieldIssue?.body).not.toMatch(unpairedSurrogate);
  expect(fieldIssue).not.toHaveProperty("url");

  const limit = 20_000;
  const messageCount = 50;
  const marker = "BOUNDARY";
  const messages = Array.from({ length: messageCount - 1 }, () => "");
  const probe = render([...messages, `${marker}!!tail`]);
  const markerOffset = probe?.body.indexOf(marker) ?? -1;
  expect(markerOffset).toBeGreaterThanOrEqual(0);
  let padding = limit - 1 - markerOffset - marker.length;
  expect(padding).toBeGreaterThanOrEqual(0);

  // Fill earlier fields within their 500-unit caps to align the body boundary.
  for (let index = 0; index < messages.length; index += 1) {
    const length = Math.min(padding, 500);
    messages[index] = "x".repeat(length);
    padding -= length;
  }
  expect(padding).toBe(0);
  const aligned = render([...messages, `${marker}!!tail`]);
  expect(aligned?.body.slice(limit - 1 - marker.length, limit)).toBe(`${marker}!`);

  const issue = render([...messages, `${marker}🎉tail`]);
  expect(issue?.body).not.toMatch(unpairedSurrogate);
  expect(issue).not.toHaveProperty("url");
  expect(issue?.body).toHaveLength(limit - 1);
  expect(issue?.body.endsWith(marker)).toBe(true);
});
function writeFailedManifest(
  store: TestStore,
  fileName: string,
  failedAt: string,
  target: { agentId?: string; storePath?: string } = {},
): void {
  const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  writeJson(path.join(runsDir, fileName), {
    failedAt,
    manifestVersion: 1,
    openClawVersion: "test",
    runId: path.basename(fileName, ".json"),
    startedAt: failedAt,
    targets: [
      failureTarget(store, {
        agentId: target.agentId ?? "older",
        issues: [{ code: "older_failure", message: "older failure" }],
        sqlitePath: path.join(store.tempDir, "older.sqlite"),
        storePath: target.storePath ?? path.join(store.tempDir, "older-sessions.json"),
      }),
    ],
  });
}
