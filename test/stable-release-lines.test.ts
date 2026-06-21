import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  StableReleaseLinesError,
  applyStableReleaseLinesTransition,
  deriveStableReleaseLinesState,
  serializeCanonicalJson,
  serializeStableReleaseLines,
  stableReleaseLinesSha256,
  validateStableReleaseLines,
} from "../scripts/lib/stable-release-lines.mjs";
import { parseArgs as parseCliArgs } from "../scripts/stable-release-lines.mjs";

const cliPath = path.resolve(import.meta.dirname, "../scripts/stable-release-lines.mjs");
const evidenceSha = "a".repeat(64);
const handoffSha = "b".repeat(64);
const tempRoots: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(packageVersion: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), "openclaw-stable-lines-"));
  tempRoots.push(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "Stable Lines Test"]);
  git(repo, ["config", "user.email", "stable-lines@example.test"]);
  writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ version: packageVersion })}\n`,
  );
  git(repo, ["add", "package.json"]);
  git(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

function commitMetadata(repo: string, message: string): void {
  git(repo, ["add", "release/stable-lines.json", "package.json"]);
  git(repo, ["commit", "--quiet", "-m", message]);
}

function runCli(repo: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}

function transition(metadata: unknown, dailyMonth: string, command: Record<string, unknown>) {
  return applyStableReleaseLinesTransition({ metadata, dailyMonth, command });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("stable release line validation", () => {
  it("validates a closed v1 document and produces deterministic canonical bytes", () => {
    const planned = transition(null, "2026.7", {
      operation: "plan",
      month: "2026.6",
      effectiveDate: "2026-06-30",
      rotationDate: "2026-07-31",
    });

    expect(validateStableReleaseLines(planned, { dailyMonth: "2026.7" })).toEqual(planned);
    expect(serializeStableReleaseLines(planned)).toBe(serializeCanonicalJson(planned));
    expect(serializeStableReleaseLines(planned)).toMatch(
      /^\{"lastTransition":.*,"lines":\[.*\],"version":1\}\n$/u,
    );
    expect(stableReleaseLinesSha256(planned)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects unknown fields and non-contiguous publication history", () => {
    const planned = transition(null, "2026.7", {
      operation: "plan",
      month: "2026.6",
      effectiveDate: "2026-06-30",
      rotationDate: "2026-07-31",
    });
    expect(() => validateStableReleaseLines({ ...planned, extra: true })).toThrow(
      "stable lines has unknown field: extra",
    );

    const line = planned.lines[0];
    const invalid = {
      ...planned,
      lines: [
        {
          ...line,
          publishedVersions: ["2026.6.34"],
          publicationEvidence: [
            {
              version: "2026.6.34",
              evidenceRef: "closeout/2026.6.34",
              evidenceSha256: evidenceSha,
            },
          ],
        },
      ],
    };
    expect(() => validateStableReleaseLines(invalid, { dailyMonth: "2026.7" })).toThrow(
      "publishedVersions must start at baseVersion",
    );
    expect(() =>
      applyStableReleaseLinesTransition({
        metadata: null,
        dailyMonth: "2026.7",
        command: {
          operation: "plan",
          month: "2026.6",
          effectiveDate: "2026-06-30",
          rotationDate: "2026-07-31",
          extra: true,
        },
      }),
    ).toThrow("command has unknown field: extra");
  });

  it("permits the first bootstrap only after main enters the July daily line", () => {
    expect(() =>
      transition(null, "2026.6", {
        operation: "plan",
        month: "2026.5",
        effectiveDate: "2026-06-30",
        rotationDate: "2026-07-31",
      }),
    ).toThrow("bootstrap without metadata requires dailyMonth 2026.7 and month 2026.6");
  });
});

describe("stable release line transition examples", () => {
  it("matches all eleven normative before/after examples", () => {
    const bootstrapPlan = transition(null, "2026.7", {
      operation: "plan",
      month: "2026.6",
      effectiveDate: "2026-06-30",
      rotationDate: "2026-07-31",
    });
    expect(deriveStableReleaseLinesState(bootstrapPlan, "2026.7")).toBe("bootstrap");
    expect(bootstrapPlan.lines[0]).toEqual({
      month: "2026.6",
      baseVersion: "2026.6.33",
      branch: "stable/2026.6.33",
      status: "planned",
      publishedVersions: [],
      publicationEvidence: [],
      currentVersion: null,
      supportStartedOn: null,
      targetRotationOn: "2026-07-31",
      retiredOn: null,
      rollbackTarget: { kind: "selector-unset" },
    });
    expect(bootstrapPlan.lastTransition).toEqual({
      operation: "plan",
      fromVersion: null,
      toVersion: null,
      publishedVersion: null,
      proofRef: null,
      proofSha256: null,
      effectiveDate: "2026-06-30",
    });

    const firstRecorded = transition(bootstrapPlan, "2026.7", {
      operation: "record-published",
      version: "2026.6.33",
      effectiveDate: "2026-06-30",
      evidenceRef: "closeout/2026.6.33",
      evidenceSha256: evidenceSha,
    });
    expect(firstRecorded.lines[0]).toMatchObject({
      status: "planned",
      currentVersion: null,
      publishedVersions: ["2026.6.33"],
      publicationEvidence: [
        {
          version: "2026.6.33",
          evidenceRef: "closeout/2026.6.33",
          evidenceSha256: evidenceSha,
        },
      ],
    });
    expect(firstRecorded.lastTransition).toMatchObject({
      operation: "record-published",
      fromVersion: null,
      toVersion: null,
      publishedVersion: "2026.6.33",
    });

    const bootstrapActivated = transition(firstRecorded, "2026.7", {
      operation: "activate",
      month: "2026.6",
      version: "2026.6.33",
      effectiveDate: "2026-06-30",
      handoffRef: "selector/2026.6.33",
      handoffSha256: handoffSha,
    });
    expect(deriveStableReleaseLinesState(bootstrapActivated, "2026.7")).toBe("steady");
    expect(bootstrapActivated.lines[0]).toMatchObject({
      status: "active",
      currentVersion: "2026.6.33",
      supportStartedOn: "2026-06-30",
      rollbackTarget: { kind: "selector-unset" },
    });
    expect(bootstrapActivated.lastTransition).toMatchObject({
      operation: "activate",
      fromVersion: null,
      toVersion: "2026.6.33",
      effectiveDate: "2026-06-30",
    });

    const bootstrapUnset = transition(bootstrapActivated, "2026.7", {
      operation: "rollback-unset",
      month: "2026.6",
      effectiveDate: "2026-07-01",
      rotationDate: "2026-07-31",
      handoffRef: "selector/unset",
      handoffSha256: handoffSha,
    });
    expect(deriveStableReleaseLinesState(bootstrapUnset, "2026.7")).toBe("bootstrap");
    expect(bootstrapUnset.lines[0]).toMatchObject({
      status: "planned",
      currentVersion: null,
      publishedVersions: ["2026.6.33"],
      supportStartedOn: null,
      targetRotationOn: "2026-07-31",
      retiredOn: null,
      rollbackTarget: { kind: "selector-unset" },
    });
    expect(bootstrapUnset.lastTransition).toMatchObject({
      operation: "rollback-unset",
      fromVersion: "2026.6.33",
      toVersion: null,
      effectiveDate: "2026-07-01",
    });

    const junePatchRecorded = transition(bootstrapActivated, "2026.7", {
      operation: "record-published",
      version: "2026.6.34",
      effectiveDate: "2026-07-02",
      evidenceRef: "closeout/2026.6.34",
      evidenceSha256: evidenceSha,
    });
    const junePatched = transition(junePatchRecorded, "2026.7", {
      operation: "patch",
      version: "2026.6.34",
      effectiveDate: "2026-07-02",
      handoffRef: "selector/2026.6.34",
      handoffSha256: handoffSha,
    });

    const stagingPlan = transition(junePatched, "2026.8", {
      operation: "plan",
      month: "2026.7",
      effectiveDate: "2026-07-31",
      rotationDate: "2026-08-31",
    });
    expect(deriveStableReleaseLinesState(stagingPlan, "2026.8")).toBe("staging");
    expect(stagingPlan.lines[0]).toMatchObject({ status: "active", currentVersion: "2026.6.34" });
    expect(stagingPlan.lines[1]).toMatchObject({
      status: "planned",
      currentVersion: null,
      rollbackTarget: { kind: "version", version: "2026.6.34" },
    });
    expect(stagingPlan.lastTransition).toEqual({
      operation: "plan",
      fromVersion: "2026.6.34",
      toVersion: "2026.6.34",
      publishedVersion: null,
      proofRef: null,
      proofSha256: null,
      effectiveDate: "2026-07-31",
    });

    const nextRecorded = transition(stagingPlan, "2026.8", {
      operation: "record-published",
      version: "2026.7.33",
      effectiveDate: "2026-07-31",
      evidenceRef: "closeout/2026.7.33",
      evidenceSha256: evidenceSha,
    });
    expect(nextRecorded.lines[1]).toMatchObject({
      status: "planned",
      currentVersion: null,
      publishedVersions: ["2026.7.33"],
    });
    expect(nextRecorded.lastTransition).toMatchObject({
      operation: "record-published",
      fromVersion: "2026.6.34",
      toVersion: "2026.6.34",
      publishedVersion: "2026.7.33",
      effectiveDate: "2026-07-31",
    });

    const monthlyActivated = transition(nextRecorded, "2026.8", {
      operation: "activate",
      month: "2026.7",
      version: "2026.7.33",
      effectiveDate: "2026-07-31",
      handoffRef: "selector/2026.7.33",
      handoffSha256: handoffSha,
    });
    expect(deriveStableReleaseLinesState(monthlyActivated, "2026.8")).toBe("steady");
    expect(monthlyActivated.lines[0]).toMatchObject({
      status: "retired",
      retiredOn: "2026-07-31",
    });
    expect(monthlyActivated.lines[1]).toMatchObject({
      status: "active",
      currentVersion: "2026.7.33",
      supportStartedOn: "2026-07-31",
      rollbackTarget: { kind: "version", version: "2026.6.34" },
    });
    expect(monthlyActivated.lastTransition).toMatchObject({
      operation: "activate",
      fromVersion: "2026.6.34",
      toVersion: "2026.7.33",
      effectiveDate: "2026-07-31",
    });

    const patchRecorded = transition(monthlyActivated, "2026.8", {
      operation: "record-published",
      version: "2026.7.34",
      effectiveDate: "2026-08-02",
      evidenceRef: "closeout/2026.7.34",
      evidenceSha256: evidenceSha,
    });
    expect(patchRecorded.lines[1]).toMatchObject({
      currentVersion: "2026.7.33",
      publishedVersions: ["2026.7.33", "2026.7.34"],
    });
    expect(patchRecorded.lastTransition).toMatchObject({
      operation: "record-published",
      fromVersion: "2026.7.33",
      toVersion: "2026.7.33",
      publishedVersion: "2026.7.34",
      effectiveDate: "2026-08-02",
    });

    const patchSelected = transition(patchRecorded, "2026.8", {
      operation: "patch",
      version: "2026.7.34",
      effectiveDate: "2026-08-02",
      handoffRef: "selector/2026.7.34",
      handoffSha256: handoffSha,
    });
    expect(patchSelected.lines[1]).toMatchObject({
      currentVersion: "2026.7.34",
      rollbackTarget: { kind: "version", version: "2026.7.33" },
    });
    expect(patchSelected.lastTransition).toMatchObject({
      operation: "patch",
      fromVersion: "2026.7.33",
      toVersion: "2026.7.34",
      effectiveDate: "2026-08-02",
    });

    const sameLineRollback = transition(patchSelected, "2026.8", {
      operation: "rollback-version",
      to: "2026.7.33",
      effectiveDate: "2026-08-03",
      handoffRef: "selector/rollback-2026.7.33",
      handoffSha256: handoffSha,
    });
    expect(deriveStableReleaseLinesState(sameLineRollback, "2026.8")).toBe("steady");
    expect(sameLineRollback.lines[1]).toMatchObject({
      currentVersion: "2026.7.33",
      publishedVersions: ["2026.7.33", "2026.7.34"],
      rollbackTarget: { kind: "version", version: "2026.7.34" },
    });
    expect(sameLineRollback.lastTransition).toMatchObject({
      operation: "rollback-version",
      fromVersion: "2026.7.34",
      toVersion: "2026.7.33",
      effectiveDate: "2026-08-03",
    });

    const crossLineRollback = transition(patchSelected, "2026.8", {
      operation: "rollback-version",
      to: "2026.6.34",
      effectiveDate: "2026-08-04",
      rotationDate: "2026-08-31",
      handoffRef: "selector/rollback-2026.6.34",
      handoffSha256: handoffSha,
    });
    expect(deriveStableReleaseLinesState(crossLineRollback, "2026.8")).toBe("cross-line-rollback");
    expect(crossLineRollback.lines[0]).toMatchObject({
      status: "active",
      currentVersion: "2026.6.34",
      retiredOn: null,
      targetRotationOn: "2026-08-31",
      rollbackTarget: { kind: "version", version: "2026.7.34" },
    });
    expect(crossLineRollback.lines[1]).toMatchObject({
      status: "retired",
      currentVersion: "2026.7.34",
      retiredOn: "2026-08-04",
    });
    expect(crossLineRollback.lastTransition).toMatchObject({
      operation: "rollback-version",
      fromVersion: "2026.7.34",
      toVersion: "2026.6.34",
      effectiveDate: "2026-08-04",
    });
  });

  it("prioritizes planned-line-exists and rejects date or evidence regressions", () => {
    const planned = transition(null, "2026.7", {
      operation: "plan",
      month: "2026.6",
      effectiveDate: "2026-06-30",
      rotationDate: "2026-07-31",
    });

    expect(() =>
      transition(planned, "not-a-month", {
        operation: "plan",
        month: "invalid",
        effectiveDate: "invalid",
        rotationDate: "invalid",
      }),
    ).toThrowError(expect.objectContaining({ code: "planned-line-exists" }));
    expect(() =>
      transition(planned, "2026.7", {
        operation: "record-published",
        version: "2026.6.33",
        effectiveDate: "2026-06-29",
        evidenceRef: "closeout/2026.6.33",
        evidenceSha256: evidenceSha,
      }),
    ).toThrow("effective-date cannot precede the prior transition date");
    expect(() =>
      transition(planned, "2026.7", {
        operation: "record-published",
        version: "2026.6.33",
        effectiveDate: "2026-06-30",
        evidenceRef: "closeout/2026.6.33",
        evidenceSha256: "A".repeat(64),
      }),
    ).toThrow("evidence-sha must be 64 lowercase hexadecimal characters");
  });
});

describe("stable release lines CLI", () => {
  it("parses only the exact command and flag matrix", () => {
    const commands = [
      [
        [
          "plan",
          "--month",
          "2026.6",
          "--effective-date",
          "2026-06-30",
          "--rotation-date",
          "2026-07-31",
        ],
        "plan",
      ],
      [
        [
          "record-published",
          "--version",
          "2026.6.33",
          "--effective-date",
          "2026-06-30",
          "--evidence-ref",
          "closeout/2026.6.33",
          "--evidence-sha",
          evidenceSha,
        ],
        "record-published",
      ],
      [
        [
          "activate",
          "--month",
          "2026.6",
          "--version",
          "2026.6.33",
          "--effective-date",
          "2026-06-30",
          "--handoff-ref",
          "selector/2026.6.33",
          "--handoff-sha",
          handoffSha,
        ],
        "activate",
      ],
      [
        [
          "patch",
          "--version",
          "2026.6.34",
          "--effective-date",
          "2026-07-02",
          "--handoff-ref",
          "selector/2026.6.34",
          "--handoff-sha",
          handoffSha,
        ],
        "patch",
      ],
      [
        [
          "rollback-version",
          "--to",
          "2026.6.33",
          "--effective-date",
          "2026-07-03",
          "--handoff-ref",
          "selector/rollback-2026.6.33",
          "--handoff-sha",
          handoffSha,
          "--rotation-date",
          "2026-07-31",
        ],
        "rollback-version",
      ],
      [
        [
          "rollback-unset",
          "--month",
          "2026.6",
          "--effective-date",
          "2026-07-01",
          "--rotation-date",
          "2026-07-31",
          "--handoff-ref",
          "selector/unset",
          "--handoff-sha",
          handoffSha,
        ],
        "rollback-unset",
      ],
    ] as const;

    for (const [argv, operation] of commands) {
      expect(parseCliArgs([...argv, "--write"])).toMatchObject({
        commandName: operation,
        write: true,
        command: { operation },
      });
    }
    expect(parseCliArgs(["status", "--json"])).toEqual({
      commandName: "status",
      write: false,
      command: null,
    });
    expect(() => parseCliArgs(["plan", "--month", "2026.6"])).toThrow(
      "missing required flag: --effective-date",
    );
    expect(() =>
      parseCliArgs([
        "plan",
        "--month",
        "2026.6",
        "--month",
        "2026.7",
        "--effective-date",
        "2026-06-30",
        "--rotation-date",
        "2026-07-31",
      ]),
    ).toThrow("--month may be provided only once");
  });

  it("is dry-run-first, writes atomically, and reports committed HEAD only", () => {
    const repo = createRepo("2026.7.1");
    const args = [
      "plan",
      "--month",
      "2026.6",
      "--effective-date",
      "2026-06-30",
      "--rotation-date",
      "2026-07-31",
    ];
    const dryRun = runCli(repo, args);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe("");
    expect(() => readFileSync(path.join(repo, "release/stable-lines.json"))).toThrow();

    const write = runCli(repo, [...args, "--write"]);
    expect(write.status).toBe(0);
    expect(write.stderr).toBe("");
    expect(write.stdout).toBe(dryRun.stdout);
    expect(readFileSync(path.join(repo, "release/stable-lines.json"), "utf8")).toBe(write.stdout);
    commitMetadata(repo, "plan stable line");

    writeFileSync(path.join(repo, "package.json"), '{"version":"2099.12.1"}\n');
    const status = runCli(repo, ["status", "--json"]);
    expect(status.status).toBe(0);
    expect(status.stderr).toBe("");
    const parsed = JSON.parse(status.stdout);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      state: "bootstrap",
      sourceSha: git(repo, ["rev-parse", "HEAD"]),
      stableLinesSha256: stableReleaseLinesSha256(JSON.parse(write.stdout)),
      dailyMonth: "2026.7",
      active: null,
      planned: { month: "2026.6", status: "planned" },
      retired: [],
    });
    expect(status.stdout).toBe(serializeCanonicalJson(parsed));
  });

  it("emits closed failures, preserves bytes, and never accepts status overrides", () => {
    const missingRepo = createRepo("2026.7.1");
    const missing = runCli(missingRepo, ["status", "--json"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe(
      '{"error":{"code":"stable-lines-missing","reason":"release/stable-lines.json is absent from committed HEAD"},"schemaVersion":1}\n',
    );

    const override = runCli(missingRepo, ["status", "--json", "--source", "main"]);
    expect(override.status).not.toBe(0);
    expect(override.stdout).toBe("");
    expect(JSON.parse(override.stderr)).toEqual({
      schemaVersion: 1,
      error: { code: "invalid-arguments", reason: "status accepts only --json" },
    });

    mkdirSync(path.join(missingRepo, "release"));
    writeFileSync(path.join(missingRepo, "release/stable-lines.json"), "do not replace\n");
    const before = readFileSync(path.join(missingRepo, "release/stable-lines.json"), "utf8");
    const invalid = runCli(missingRepo, [
      "plan",
      "--month",
      "2026.5",
      "--effective-date",
      "2026-06-30",
      "--rotation-date",
      "2026-07-31",
      "--write",
    ]);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(readFileSync(path.join(missingRepo, "release/stable-lines.json"), "utf8")).toBe(before);
  });

  it("uses the closed error type for transition failures", () => {
    const error = new StableReleaseLinesError("transition-not-allowed", "not allowed");
    expect(error).toMatchObject({ code: "transition-not-allowed", message: "not allowed" });
  });
});
