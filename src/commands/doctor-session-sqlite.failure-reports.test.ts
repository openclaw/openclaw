import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as sqliteImport from "../config/sessions/session-accessor.sqlite-import.js";
import { prepareGithubIssue } from "../infra/github-issue.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  clearSessionSqliteMigrationGithubIssueClaim,
  createSessionSqliteMigrationFailureIssue,
  writeSessionSqliteMigrationFailureReports,
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

function failureManifest(
  store: TestStore,
  runId: string,
  overrides: Partial<SessionSqliteMigrationManifest> = {},
): SessionSqliteMigrationManifest {
  return {
    failedAt: "2030-01-01T00:00:00.000Z",
    manifestVersion: 3,
    openClawVersion: "test",
    runId,
    startedAt: "2030-01-01T00:00:00.000Z",
    targets: [
      {
        ...trustedMigrationTarget(store),
        completedMoves: [],
        issues: [{ code: "startup_failure", message: "sanitized failure" }],
        plannedMoves: [],
        validationBeforeArchive: "failed",
      },
    ],
    ...overrides,
  };
}

describe("runDoctorSessionSqlite", () => {
  it.each([false, true])(
    "records a rejected SQLite import (journal failure=%s)",
    async (journalFailure) => {
      const store = createLegacyStore();
      const failure = "attempt to write a readonly database";
      const importError = new Error(failure);
      const recordError = new Error("fixture migration journal write failed");
      const importSpy = vi
        .spyOn(sqliteImport, "importSqliteSessionRowsBatch")
        .mockRejectedValueOnce(importError);
      const journalSpy = journalFailure
        ? vi.spyOn(migrationRun, "updateMigrationManifestTarget").mockImplementationOnce(() => {
            throw recordError;
          })
        : undefined;
      try {
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
      } finally {
        importSpy.mockRestore();
        journalSpy?.mockRestore();
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
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(manifest.completedAt).toBeUndefined();
      const recovered = await runDoctorSessionSqlite({ cfg: {}, env: store.env, mode: "recover" });
      expect(recovered.supportIssue?.body).toContain(`[sqlite_import_failed] ${failure}`);
      expect(recovered.supportIssue?.body).toContain(`- Failed: ${manifest.failedAt}`);
    },
  );

  it.each([false, true])(
    "recovers the latest matching failed run and reports only current issues (explicit store=%s)",
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
        manifest.targets.push({
          agentId: "other",
          completedMoves: [],
          issues: [
            { code: "unselected_failure", message: "unselected target should stay private" },
          ],
          plannedMoves: [],
          sqlitePath: path.join(store.tempDir, "other.sqlite"),
          storePath: path.join(store.tempDir, "other", "sessions.json"),
          validationBeforeArchive: "failed",
        });
        writeFailedManifest(store, "newer-unselected.json", "2040-01-01T00:00:00.000Z", {
          agentId: "other",
          storePath: path.join(store.tempDir, "other", "sessions.json"),
        });
      } else {
        writeFailedManifest(store, "older-failed.json", "2000-01-01T00:00:00.000Z");
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
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
      expect(recover.supportIssue?.body).toContain("startup_failure");
      expect(recover.supportIssue?.body).toContain("restore_conflict");
      expect(recover.supportIssue?.body).toContain(`- Failed: ${manifest.failedAt}`);
      expect(recover.supportIssue?.body).not.toContain("agent:main:main");
      expect(recover.supportIssue?.body).not.toContain("supersecret");
      expect(recover.supportIssue?.body).not.toContain("conflicting legacy event");
      expect(recover.supportIssue?.body).not.toContain(store.storePath);
      if (process.env.HOME) {
        expect(recover.supportIssue?.body).not.toContain(process.env.HOME);
      }
      expect(recover.supportIssue).not.toHaveProperty("url");
    },
  );

  it.each(["empty-report", "restored", "completed"] as const)(
    "keeps clean recovery out of support reports despite previous evidence or work (%s)",
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
        evidence === "completed"
          ? { completedAt: "2030-01-01T00:00:00.000Z", failedAt: undefined }
          : {},
      );
      const target = manifest.targets[0]!;
      target.validationBeforeArchive = "not_run";
      target.issues = [];
      if (evidence === "restored") {
        const archivePath = path.join(
          store.stateDir,
          "agents",
          "main",
          "session-sqlite-import-archive",
          "legacy-store.sessions.json.imported-1",
        );
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.writeFileSync(archivePath, "{}\n");
        const move = {
          archivePath,
          kind: "legacy-store" as const,
          sourcePath: manifest.targets[0]!.storePath,
        };
        manifest.targets[0]!.plannedMoves.push(move);
        manifest.targets[0]!.completedMoves.push(move);
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const previousReports =
        evidence === "empty-report"
          ? writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "Earlier recovery" })
          : undefined;
      const previousBytes = previousReports
        ? [previousReports.jsonPath, previousReports.markdownPath].map((file) =>
            fs.readFileSync(file),
          )
        : undefined;
      const recover = await runDoctorSessionSqlite({ cfg: {}, env: store.env, mode: "recover" });
      expect(recover.totals.issues).toBe(0);
      if (evidence === "restored") {
        expect(recover.targets[0]?.restore?.restoredFiles).toEqual([
          manifest.targets[0]!.storePath,
        ]);
      }
      expect(recover.migrationRun).toEqual(
        evidence === "completed" ? undefined : { manifestPath, runId: "clean-recovery" },
      );
      expect(recover.supportIssue).toBeUndefined();
      expect(readMigrationManifest(manifestPath).targets[0]?.issues).toEqual(
        manifest.targets[0]!.issues,
      );
      if (previousReports && previousBytes) {
        expect(fs.readFileSync(previousReports.jsonPath)).toEqual(previousBytes[0]);
        expect(fs.readFileSync(previousReports.markdownPath)).toEqual(previousBytes[1]);
      } else {
        expect(fs.existsSync(manifestPath.replace(/\.json$/u, ".failure.json"))).toBe(false);
        expect(fs.existsSync(manifestPath.replace(/\.json$/u, ".failure.md"))).toBe(false);
      }
    },
  );

  it.each(["replaced", "missing"] as const)(
    "refuses a support claim when the saved report is %s during consent",
    (change) => {
      const store = createLegacyStore();
      writeFailedManifest(store, "consent-race.json", "2030-01-01T00:00:00.000Z");
      const manifestPath = path.join(
        store.stateDir,
        "session-sqlite-migration-runs",
        "consent-race.json",
      );
      const { markdownPath } = writeSessionSqliteMigrationFailureReports(manifestPath, {
        reason: "recovery before consent",
      });
      const approved = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "approved report"),
      );
      if (change === "replaced") {
        writeSessionSqliteMigrationFailureReports(manifestPath, {
          reason: "another recovery during consent",
        });
      } else {
        fs.unlinkSync(markdownPath);
      }
      const manifestBefore = fs.readFileSync(manifestPath);

      expect(
        claimSessionSqliteMigrationGithubIssue(manifestPath, approved, { assertCurrent: vi.fn() }),
      ).toBeUndefined();
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
      if (change === "missing") {
        expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toBeUndefined();
        expect(fs.existsSync(markdownPath)).toBe(false);
        return;
      }

      const current = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "current report"),
      );
      expect(current.marker).not.toBe(approved.marker);
      expect(
        claimSessionSqliteMigrationGithubIssue(manifestPath, current, { assertCurrent: vi.fn() }),
      ).toMatchObject({ issue: { marker: current.marker }, status: "claimed" });
      expect(readMigrationManifest(manifestPath).failureReports?.githubIssue?.marker).toBe(
        current.marker,
      );
    },
  );

  it.each([3] as const)(
    "persists one support issue receipt on a historical v%s manifest",
    (manifestVersion) => {
      const store = createLegacyStore();
      const manifestPath = path.join(store.tempDir, `historical-v${manifestVersion}.json`);
      const failureJsonPath = path.join(
        store.tempDir,
        `historical-v${manifestVersion}.failure.json`,
      );
      const failureMarkdownPath = path.join(
        store.tempDir,
        `historical-v${manifestVersion}.failure.md`,
      );
      const manifest = failureManifest(store, `historical-v${manifestVersion}`, {
        failureReports: { jsonPath: failureJsonPath, markdownPath: failureMarkdownPath },
        manifestVersion,
        openClawVersion: "historical",
      });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const authority = { assertCurrent: vi.fn() };
      fs.writeFileSync(failureMarkdownPath, `stable sanitized report v${manifestVersion}\n`, {
        mode: 0o600,
      });
      const { marker, title } = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "historical report"),
      );
      const issue = { marker, title };

      expect(claimSessionSqliteMigrationGithubIssue(manifestPath, issue, authority)).toMatchObject({
        issue: { ...issue, status: "attempted" },
        status: "claimed",
      });
      expect(
        claimSessionSqliteMigrationGithubIssue(
          manifestPath,
          { ...issue, title: "regenerated title must not replace the claim" },
          authority,
        ),
      ).toMatchObject({ issue: { ...issue, status: "attempted" }, status: "existing" });

      writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "retry" });
      expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toMatchObject({
        body: expect.stringContaining(`stable sanitized report v${manifestVersion}`),
        title: issue.title,
      });
      const receiptManifest = readMigrationManifest(manifestPath);
      expect(receiptManifest).toMatchObject({
        failureReports: { githubIssue: { ...issue, status: "attempted" } },
        manifestVersion: 4,
      });
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...receiptManifest, manifestVersion }, null, 2)}\n`,
        { mode: 0o600 },
      );
      expect(migrationRun.readSessionSqliteMigrationManifest(manifestPath)).toBeUndefined();
      fs.writeFileSync(manifestPath, `${JSON.stringify(receiptManifest, null, 2)}\n`, {
        mode: 0o600,
      });
      expect(
        claimSessionSqliteMigrationGithubIssue(
          manifestPath,
          {
            marker: `openclaw-report:${"c".repeat(64)}`,
            title: "regenerated process must not replace the claim",
          },
          authority,
        ),
      ).toMatchObject({ issue: { ...issue, status: "attempted" }, status: "existing" });
      const receiptJson = fs.readFileSync(manifestPath, "utf8");
      expect(receiptJson).not.toContain(`stable sanitized report v${manifestVersion}`);
      expect(receiptJson).not.toContain("github.com/openclaw/openclaw/issues/");
      expect(receiptJson).not.toContain("openclaw doctor");
      expect(receiptJson).not.toContain('"body"');
      expect(receiptJson).not.toContain("?body=");
      expect(fs.readFileSync(failureMarkdownPath, "utf8")).toBe(
        `stable sanitized report v${manifestVersion}\n`,
      );
      expect(
        clearSessionSqliteMigrationGithubIssueClaim(manifestPath, issue.marker, authority),
      ).toBe(true);
      const clearedManifest = readMigrationManifest(manifestPath);
      expect(clearedManifest.manifestVersion).toBe(4);
      expect(clearedManifest.failureReports).not.toHaveProperty("githubIssue");
      expect(authority.assertCurrent).toHaveBeenCalledTimes(4);
    },
  );

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
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(untrustedJsonPath, "private json sentinel\n", { mode: 0o600 });
    fs.writeFileSync(untrustedMarkdownPath, "private markdown sentinel\n", { mode: 0o600 });

    expect(writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "failed" })).toEqual({
      jsonPath: expectedJsonPath,
      markdownPath: expectedMarkdownPath,
    });
    expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toMatchObject({
      body: expect.not.stringContaining("private markdown sentinel"),
      bodyPath: expectedMarkdownPath,
    });
    expect(fs.readFileSync(untrustedJsonPath, "utf8")).toBe("private json sentinel\n");
    expect(fs.readFileSync(untrustedMarkdownPath, "utf8")).toBe("private markdown sentinel\n");
    expect(readMigrationManifest(manifestPath).failureReports).toEqual({
      jsonPath: expectedJsonPath,
      markdownPath: expectedMarkdownPath,
    });
  });

  it("keeps bounded GitHub issue bodies on a valid UTF-16 boundary", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "failed-migration.json");
    const unpairedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const writeManifest = (messages: string[]) => {
      const manifest = failureManifest(store, "utf16-boundary", {
        manifestVersion: 2,
        targets: Array.from({ length: Math.ceil(messages.length / 10) }, (_, index) => {
          return {
            agentId: `agent-${index}`,
            completedMoves: [],
            issues: messages.slice(index * 10, (index + 1) * 10).map((message) => ({
              code: "startup_failure",
              message,
            })),
            plannedMoves: [],
            sqlitePath: path.join(store.tempDir, "openclaw-agent.sqlite"),
            storePath: store.storePath,
            validationBeforeArchive: "failed",
          };
        }),
      });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    };

    writeManifest([`${"x".repeat(499)}🎉tail`]);
    const fieldIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(fieldIssue?.body).toContain(`${"x".repeat(499)}\n`);
    expect(fieldIssue?.body).not.toContain("🎉tail");
    expect(fieldIssue?.body).not.toMatch(unpairedSurrogate);
    expect(fieldIssue).not.toHaveProperty("url");

    const limit = 20_000;
    const messageCount = 50;
    const marker = "BOUNDARY";
    const messages = Array.from({ length: messageCount - 1 }, () => "");
    writeManifest([...messages, `${marker}!!tail`]);
    const probe = createSessionSqliteMigrationFailureIssue(manifestPath);
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
    writeManifest([...messages, `${marker}!!tail`]);
    const aligned = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(aligned?.body.slice(limit - 1 - marker.length, limit)).toBe(`${marker}!`);

    writeManifest([...messages, `${marker}🎉tail`]);
    const issue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(issue?.body).not.toMatch(unpairedSurrogate);
    expect(issue).not.toHaveProperty("url");
    expect(issue?.body).toHaveLength(limit - 1);
    expect(issue?.body.endsWith(marker)).toBe(true);
  });
});

function writeFailedManifest(
  store: TestStore,
  fileName: string,
  failedAt: string,
  target: { agentId?: string; storePath?: string } = {},
): void {
  const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(runsDir, fileName),
    `${JSON.stringify(
      {
        failedAt,
        manifestVersion: 1,
        openClawVersion: "test",
        runId: path.basename(fileName, ".json"),
        startedAt: failedAt,
        targets: [
          {
            agentId: target.agentId ?? "older",
            completedMoves: [],
            issues: [{ code: "older_failure", message: "older failure" }],
            plannedMoves: [],
            sqlitePath: path.join(store.tempDir, "older.sqlite"),
            storePath: target.storePath ?? path.join(store.tempDir, "older-sessions.json"),
            validationBeforeArchive: "failed",
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
