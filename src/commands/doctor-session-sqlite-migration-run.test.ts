import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionSqliteMigrationFailureIssue,
  type ActiveSessionSqliteMigrationRun,
} from "./doctor-session-sqlite-migration-run.js";

// Derive the manifest type from the exported active-run shape instead of
// importing SessionSqliteMigrationManifest directly, so the production module
// does not need to export a type whose only external consumer is this test
// (which would trip the repository unused-export audit). This mirrors the
// pattern used in doctor-session-sqlite.test.ts.
type SessionSqliteMigrationManifest = ActiveSessionSqliteMigrationRun["manifest"];

// A surrogate pair spans two UTF-16 code units; a lone half is malformed.
// Detecting any lone surrogate in the rendered body proves a bad truncation.
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    const high = unit >= 0xd800 && unit <= 0xdbff;
    const low = unit >= 0xdc00 && unit <= 0xdfff;
    if (high) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
    } else if (low) {
      const prev = value.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) {
        return true;
      }
    }
  }
  return false;
}

function buildManifest(issueMessage: string, targetCount: number): SessionSqliteMigrationManifest {
  return {
    manifestVersion: 1,
    openClawVersion: "test",
    runId: "run-test-utf16",
    startedAt: "2026-07-12T00:00:00.000Z",
    failedAt: "2026-07-12T00:00:01.000Z",
    targets: Array.from({ length: targetCount }, (_, index) => ({
      agentId: `agent-${index}`,
      sqlitePath: `/tmp/agent-${index}/sessions.sqlite`,
      storePath: `/tmp/agent-${index}/store`,
      completedMoves: [],
      plannedMoves: [],
      validationBeforeArchive: "not_run" as const,
      issues: [{ code: "test-issue", message: issueMessage }],
    })),
  };
}

describe("createSessionSqliteMigrationFailureIssue UTF-16 safe truncation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-utf16-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not split surrogate pairs when the report body exceeds the body limit", () => {
    // 1 ASCII + 250 emoji = 501 code units, so the 500-char sanitizer boundary
    // also bisects a pair. The ASCII prefix offsets the dense emoji stream so a
    // raw .slice(0, 20000) is guaranteed to bisect a pair at the body boundary.
    // Many targets push the rendered report well past 20_000 chars.
    const emoji = "🔴"; // U+1F534, one surrogate pair (2 code units) per emoji
    const message = `x${emoji.repeat(250)}`; // 501 code units; sanitizer cuts at 500
    const manifest = buildManifest(message, 60);
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const issue = createSessionSqliteMigrationFailureIssue(manifestPath);

    expect(issue).toBeDefined();
    expect(issue!.body.length).toBeLessThanOrEqual(20_000);
    expect(hasLoneSurrogate(issue!.body)).toBe(false);
  });

  it("does not split surrogate pairs in the prefilled GitHub issue URL body", () => {
    // The URL body is capped at 6_000 chars. URLSearchParams encodes a lone
    // surrogate as U+FFFD, so assert absence of U+FFFD rather than lone
    // surrogates. Enough targets cross 6_000 so the URL truncation runs.
    const emoji = "🟢"; // U+1F7E2
    const message = `x${emoji.repeat(250)}`; // 501 code units
    const manifest = buildManifest(message, 20);
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const issue = createSessionSqliteMigrationFailureIssue(manifestPath);

    expect(issue).toBeDefined();
    const url = new URL(issue!.url);
    const urlBody = url.searchParams.get("body") ?? "";
    expect(urlBody).toContain("...(truncated for URL");
    // A raw .slice(0, 6000) bisecting a pair would surface as U+FFFD after
    // URLSearchParams decoding; the safe helper keeps pairs intact.
    expect(urlBody).not.toContain("\uFFFD");
  });
});
