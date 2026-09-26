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
import { createDoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
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

  it.each(["clean", "pending", "unselected"] as const)(
    "distinguishes recorded failures from current recovery findings (%s)",
    (outcome) => {
      const store = createLegacyStore();
      writeFailedManifest(store, "old-settlement.json", "2030-01-01T00:00:00.000Z", {
        agentId: "main",
        storePath: store.storePath,
      });
      const manifestPath = path.join(
        store.stateDir,
        "session-sqlite-migration-runs",
        "old-settlement.json",
      );
      const manifest = readMigrationManifest(manifestPath);
      const target = manifest.targets[0]!;
      target.issues = [
        {
          code: "retained_plugin_source_settlement_failed",
          message: "Previous migration reported another agent's transcript",
        },
      ];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const recovery = createDoctorSessionSqliteTargetReport({
        ...target,
        agentId: outcome === "unselected" ? "other" : target.agentId,
        issues:
          outcome === "pending"
            ? [
                {
                  code: "plugin_migration_source_retained",
                  message: "Original inputs remain pending for an unavailable plugin",
                },
              ]
            : [],
      });
      const paths = writeSessionSqliteMigrationFailureReports(manifestPath, {
        reason: "Recovery inspected selected targets",
        recoveryTargets: [recovery],
      });
      const markdown = fs.readFileSync(paths.markdownPath, "utf8");
      const current = markdown.split("- Recorded migration and recovery evidence:")[0]!;
      expect(current).toContain(
        outcome === "unselected"
          ? "- Current recovery: not assessed"
          : `- Current recovery issues: ${recovery.issues.length}`,
      );
      expect(current).not.toContain("[retained_plugin_source_settlement_failed]");
      if (outcome === "pending") {
        expect(current).toContain("[plugin_migration_source_retained]");
      }
      expect(markdown).toContain("[retained_plugin_source_settlement_failed]");
      const payload = JSON.parse(fs.readFileSync(paths.jsonPath, "utf8"));
      expect(payload.targets[0].issues).toContainEqual(target.issues[0]);
      expect(payload.targets[0].recoveryIssues).toEqual(
        outcome === "unselected" ? undefined : recovery.issues,
      );
      expect(createSessionSqliteMigrationFailureIssue(manifestPath)?.body).toContain(markdown);
    },
  );

  it("recovers the latest failed migration run and prepares a sanitized GitHub issue", async () => {
    const store = createLegacyStore({ agentDirName: "token=supersecret" });
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      {
        code: "startup_failure",
        message: `token=supersecret startup migration failed for agent:main:main at ${store.storePath} and ${process.env.HOME ?? "/Users/example"}/private/openclaw.json`,
        sessionKey: "agent:main:main",
      },
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFailedManifest(store, "older-failed.json", "2000-01-01T00:00:00.000Z");
    const conflictingTranscript =
      '{"type":"session","sessionId":"session-1"}\n' +
      '{"type":"event","id":"evt-1","text":"conflicting legacy event"}\n';
    fs.writeFileSync(store.transcriptPath, conflictingTranscript, { mode: 0o600 });

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
    });

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
    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    expect(recover.targets[0]?.restore?.restoredFiles).toEqual(
      expect.arrayContaining(canonicalTestPaths([store.trajectoryPath])),
    );
    expect(recover.targets[0]?.restore?.conflicts).toEqual([
      expect.objectContaining({ sourcePath: canonicalTestPaths([store.transcriptPath])[0] }),
    ]);
    expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe(conflictingTranscript);
    expect(recover.supportIssue?.title).toContain(manifest.runId);
    expect(recover.supportIssue?.body).toContain("startup_failure");
    expect(recover.supportIssue?.body).toContain(`- Failed: ${manifest.failedAt}`);
    expect(recover.supportIssue?.body).not.toContain("agent:main:main");
    expect(recover.supportIssue?.body).not.toContain("supersecret");
    expect(recover.supportIssue?.body).not.toContain("conflicting legacy event");
    expect(recover.supportIssue?.body).not.toContain(store.storePath);
    if (process.env.HOME) {
      expect(recover.supportIssue?.body).not.toContain(process.env.HOME);
    }
    expect(recover.supportIssue).not.toHaveProperty("url");
  });

  it("keeps a support report for a restore conflict without replacing the current source", async () => {
    const store = createLegacyStore();
    const imported = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const replacement = '{"type":"event","id":"newer-source"}\n';
    fs.writeFileSync(store.transcriptPath, replacement, { mode: 0o600 });

    const recover = await runDoctorSessionSqlite({ cfg: {}, env: store.env, mode: "recover" });

    expect(recover.targets[0]?.restore?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: canonicalTestPaths([store.transcriptPath])[0] }),
      ]),
    );
    expect(recover.targets[0]?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "restore_conflict" })]),
    );
    expect(recover.supportIssue?.body).toContain("restore_conflict");
    expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe(replacement);
  });

  it.each(["none", "empty-report", "recorded-failure", "restored", "completed"] as const)(
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
      const manifest: SessionSqliteMigrationManifest = {
        ...(evidence === "completed"
          ? { completedAt: "2030-01-01T00:00:00.000Z" }
          : { failedAt: "2030-01-01T00:00:00.000Z" }),
        manifestVersion: 3,
        openClawVersion: "test",
        runId: "clean-recovery",
        startedAt: "2030-01-01T00:00:00.000Z",
        targets: [
          {
            ...trustedMigrationTarget(store),
            completedMoves: [],
            issues:
              evidence === "recorded-failure"
                ? [
                    {
                      code: "sqlite_import_failed",
                      message: "attempt to write a readonly database",
                    },
                  ]
                : [],
            plannedMoves: [],
            validationBeforeArchive: "not_run",
          },
        ],
      };
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

  it.each([1, 2, 3] as const)(
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
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        failureReports: { jsonPath: failureJsonPath, markdownPath: failureMarkdownPath },
        manifestVersion,
        openClawVersion: "historical",
        runId: `historical-v${manifestVersion}`,
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
      };
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
      const beforeHistoricalRewrite = fs.readFileSync(manifestPath, "utf8");
      expect(simulateHistoricalFailureReportRewrite(manifestPath)).toBe(false);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(beforeHistoricalRewrite);
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
      expect(simulateHistoricalFailureReportRewrite(manifestPath)).toBe(false);
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
    const manifest: SessionSqliteMigrationManifest = {
      failedAt: "2030-01-01T00:00:00.000Z",
      failureReports: { jsonPath: untrustedJsonPath, markdownPath: untrustedMarkdownPath },
      manifestVersion: 3,
      openClawVersion: "test",
      runId: "path-ownership",
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
    };
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
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        manifestVersion: 2,
        openClawVersion: "test",
        runId: "utf16-boundary",
        startedAt: "2030-01-01T00:00:00.000Z",
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
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    };

    writeManifest([`${"x".repeat(499)}🎉tail`]);
    const fieldIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(fieldIssue?.body).toContain(`${"x".repeat(499)}\n`);
    expect(fieldIssue?.body).not.toContain("🎉tail");
    expect(fieldIssue?.body).not.toMatch(unpairedSurrogate);
    expect(fieldIssue).not.toHaveProperty("url");

    for (const [limit, messageCount] of [
      [6_000, 20],
      [20_000, 50],
    ] as const) {
      const marker = "BOUNDARY";
      const messages = Array.from({ length: messageCount - 1 }, () => "");
      writeManifest([...messages, `${marker}!!tail`]);
      const probe = createSessionSqliteMigrationFailureIssue(manifestPath);
      const markerOffset = probe?.body.indexOf(marker) ?? -1;
      expect(markerOffset).toBeGreaterThanOrEqual(0);
      let padding = limit - 1 - markerOffset - marker.length;
      expect(padding).toBeGreaterThanOrEqual(0);

      // Fill earlier fields, each within its 500-unit cap, so path length cannot
      // move the surrogate away from the URL/body boundary being exercised.
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
      if (limit === 6_000) {
        expect(issue?.body).toContain(`${marker}🎉tail`);
      } else {
        expect(issue?.body).toHaveLength(limit - 1);
        expect(issue?.body.endsWith(marker)).toBe(true);
      }
    }
  });

  it("recovers only manifests matching an explicit store selector", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      { code: "startup_failure", message: "selected store failed after archive" },
    ];
    manifest.targets.push({
      agentId: "other",
      completedMoves: [],
      issues: [{ code: "unselected_failure", message: "unselected target should stay private" }],
      plannedMoves: [],
      sqlitePath: path.join(store.tempDir, "other.sqlite"),
      storePath: path.join(store.tempDir, "other", "sessions.json"),
      validationBeforeArchive: "failed",
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFailedManifest(store, "newer-unselected.json", "2040-01-01T00:00:00.000Z", {
      agentId: "other",
      storePath: path.join(store.tempDir, "other", "sessions.json"),
    });

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    expect(recover.supportIssue).toBeUndefined();
    expect(recover.totals.issues).toBe(0);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
  });
});

function simulateHistoricalFailureReportRewrite(manifestPath: string): boolean {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    failureReports?: { jsonPath?: unknown; markdownPath?: unknown };
    manifestVersion?: unknown;
    [key: string]: unknown;
  };
  // Released Doctors accept only v1-v3. Their schema strips the unknown receipt
  // before the failure-report writer atomically serializes the parsed manifest.
  if (![1, 2, 3].includes(parsed.manifestVersion as number) || !parsed.failureReports) {
    return false;
  }
  parsed.failureReports = {
    jsonPath: parsed.failureReports.jsonPath,
    markdownPath: parsed.failureReports.markdownPath,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return true;
}

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
