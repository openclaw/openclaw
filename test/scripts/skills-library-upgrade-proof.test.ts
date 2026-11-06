import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  writePublicProof,
  type ImportProofReport,
} from "../../ui/src/e2e/skills-library-import-proof.test-support.ts";
import {
  runStablePackageCommand,
  summarizeStableNpmPolicy,
} from "../helpers/skills-library-upgrade-proof.test-support.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([
  {
    phase: "resolver" as const,
    output:
      "OpenClaw package tarball integrity failed:\ndist/proof.mjs imports missing dist/companion.cjs",
    code: null,
    classification: "tarball-missing-relative-import",
    etargetMatchesRoot: null,
    reportedBefore: null,
  },
  {
    phase: "install" as const,
    output: "npm error code E401",
    code: "E401",
    classification: "known-npm-or-runtime-code",
    etargetMatchesRoot: null,
    reportedBefore: null,
  },
  {
    phase: "resolver" as const,
    output:
      "npm error code ETARGET\nNo matching version found for openclaw@2026.11.1 with a date before 2026-10-30T18:00:00.000Z.",
    code: "ETARGET",
    classification: "known-npm-or-runtime-code",
    etargetMatchesRoot: true,
    reportedBefore: "2026-10-30T18:00:00.000Z",
  },
  {
    phase: "install" as const,
    output: "npm error code ETARGET\nNo matching version found for companion@2026.11.1.",
    code: "ETARGET",
    classification: "known-npm-or-runtime-code",
    etargetMatchesRoot: false,
    reportedBefore: null,
  },
])(
  "reports safe $phase failure facts without publishing private output",
  async ({ phase, output, code, classification, etargetMatchesRoot, reportedBefore }) => {
    const root = tempDirs.make("stable-command-proof-");
    const secret = randomUUID();
    const failure = await runStablePackageCommand(
      phase,
      "2026.11.1",
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.argv[1]); process.exit(23)",
        output + "\nAuthorization: " + secret,
      ],
      root,
      10000,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected an observable command failure");
    }
    const prefix = "Owned stable-package command failed: ";
    expect(failure.message.startsWith(prefix)).toBe(true);
    expect(JSON.parse(failure.message.slice(prefix.length))).toEqual({
      phase,
      version: "2026.11.1",
      status: 23,
      exit: 23,
      signal: null,
      code,
      etargetMatchesRoot,
      reportedBefore,
      classification,
    });
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain("Authorization");
    expect(readFileSync(path.join(root, "commands.private.log"), "utf8")).toContain(secret);
  },
);

it("summarizes only nonsecret effective npm selection facts", () => {
  const secret = randomUUID();
  const facts = summarizeStableNpmPolicy({
    before: "2026-10-30T18:00:00.000Z",
    age: "7",
    registry: "https://" + secret + "@" + secret + ".invalid/private?token=" + secret,
    version: "11.20.0",
  });
  expect(facts).toEqual({
    before: "2026-10-30T18:00:00.000Z",
    minReleaseAgeDays: 7,
    registryHost: "non-default-registry",
    npmVersion: "11.20.0",
    queriesSucceeded: true,
  });
  expect(JSON.stringify(facts)).not.toContain(secret);
});
it.each([
  { authorityStatus: "passed" as const, upgradeStatus: "not-run" as const, expected: "partial" },
  { authorityStatus: "passed" as const, upgradeStatus: "failed" as const, expected: "partial" },
  { authorityStatus: "passed" as const, upgradeStatus: "passed" as const, expected: "passed" },
  { authorityStatus: "failed" as const, upgradeStatus: "passed" as const, expected: "failed" },
])(
  "derives public status from authority=$authorityStatus upgrade=$upgradeStatus",
  async ({ authorityStatus, upgradeStatus, expected }) => {
    const directory = tempDirs.make("partial-proof-report-");
    const head = "a".repeat(40);
    const report: ImportProofReport = {
      schemaVersion: 1,
      status: "passed",
      authorityStatus,
      upgradeStatus,
      source: { expectedHead: head, observedHead: head, tree: head, buildCommit: head },
      assertions: [],
    };
    await writePublicProof(directory, report);
    expect(JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8")).status).toBe(
      expected,
    );
  },
);
