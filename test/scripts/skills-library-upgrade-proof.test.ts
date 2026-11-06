import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { GatewayClientRequestTimeoutError } from "../../packages/gateway-client/src/client.ts";
import { isGatewayProtocolResponseError } from "../../src/gateway/client.ts";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.ts";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.ts";
import {
  writePublicProof,
  classifySkillProofFailure,
  skillProofOperatorClientOptions,
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

it("reports nested worker error facts without exposing private diagnostics", () => {
  const secret = randomUUID();
  const privateText =
    "https://" + secret + "@private.invalid/" + secret + " 10.23.42.9 /private/" + secret;
  const cause = Object.assign(new Error(privateText), { code: "ERR_MODULE_NOT_FOUND" });
  const error = new AggregateError([
    new Error("database worker request timed out " + privateText, { cause }),
    new Error("worker exited with code 9 " + privateText),
  ]);
  const facts = classifySkillProofFailure(error);
  expect(facts.kinds).toContain("worker-timeout");
  expect(facts.codes).toContain("ERR_MODULE_NOT_FOUND");
  expect(facts.reportedExitCodes).toEqual([9]);
  const publicText = JSON.stringify(facts);
  for (const value of [secret, "private.invalid", "10.23.42.9", "/private/"]) {
    expect(publicText).not.toContain(value);
  }
});
it("keeps a server-close assertion a failure, never a successful denial", () => {
  let failure: unknown;
  try {
    assert.fail("gateway closed before hello");
  } catch (error) {
    failure = error;
  }
  const facts = classifySkillProofFailure(failure);
  expect(facts.kinds).toContain("assertion");
  expect(facts.kinds).toContain("gateway-close");
  expect(facts.codes).toContain("ERR_ASSERTION");
  expect(facts.kinds).not.toContain("denied");
});

it("retains a typed client deadline but never treats it as a server denial", () => {
  const error = new GatewayClientRequestTimeoutError({
    method: "skills.library.import",
    timeoutMs: 60000,
    requestSent: true,
  });
  expect(isGatewayProtocolResponseError(error)).toBe(false);
  const facts = classifySkillProofFailure(error);
  expect(facts.codes).toContain("CLIENT_TIMEOUT");
  expect(facts.kinds).toContain("timeout");
  expect(facts.clientTimeouts).toEqual([
    { method: "skills.library.import", timeoutMs: 60000, requestSent: true },
  ]);
});

it("uses a named canonical device identity and the owned operator UI contract", async () => {
  await withOpenClawTestState({ label: "skill-operator-options" }, async (state) => {
    expect(() => loadOrCreateDeviceIdentity({ path: state.path("clients/writer.json") })).toThrow(
      "Device identity path must be",
    );
    const origin = "http://127.0.0.1:54321";
    const url = "ws://127.0.0.1:12345";
    const scopes = ["operator.read", "operator.write"];
    const options = skillProofOperatorClientOptions(state, "writer", url, origin, scopes);
    expect({
      url: options.url,
      origin: options.origin,
      clientName: options.clientName,
      mode: options.mode,
      role: options.role,
      sharedStateMode: options.sharedStateMode,
      scopes: options.scopes,
    }).toEqual({
      url,
      origin,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      role: "operator",
      sharedStateMode: "read-only",
      scopes,
    });
    const identity = loadOrCreateDeviceIdentity({
      env: state.env,
      identityKey: "skills-proof-writer",
    });
    expect(options.deviceIdentity?.deviceId).toBe(identity.deviceId);
    expect(
      skillProofOperatorClientOptions(state, "writer", url, origin, scopes).deviceIdentity
        ?.deviceId,
    ).toBe(identity.deviceId);
    expect(
      skillProofOperatorClientOptions(state, "reader", url, origin, scopes).deviceIdentity
        ?.deviceId,
    ).not.toBe(identity.deviceId);
  });
});

it("keeps the upgrade client identity in the corresponding copied owned state", async () => {
  const identityKey = "skills-upgrade-proof-client";
  await withOpenClawTestState({ label: "upgrade-identity-stable" }, async (stable) => {
    const original = loadOrCreateDeviceIdentity({ env: stable.env, identityKey });
    await withOpenClawTestState({ label: "upgrade-identity-control" }, async (control) => {
      expect(loadOrCreateDeviceIdentity({ env: control.env, identityKey }).deviceId).not.toBe(
        original.deviceId,
      );
    });
    await withOpenClawTestState({ label: "upgrade-identity-candidate" }, async (candidate) => {
      expect(candidate.env.OPENCLAW_STATE_DIR !== stable.env.OPENCLAW_STATE_DIR).toBe(true);
      await cp(stable.stateDir, candidate.stateDir, { recursive: true, force: true });
      const copied = loadOrCreateDeviceIdentity({ env: candidate.env, identityKey });
      expect(copied.deviceId).toBe(original.deviceId);
      expect(loadOrCreateDeviceIdentity({ env: candidate.env, identityKey }).deviceId).toBe(
        copied.deviceId,
      );
    });
  });
});

it("exposes only the fixed proof file and numeric assertion position", () => {
  const secret = randomUUID();
  const error = new Error(secret);
  error.stack =
    "Error: " +
    secret +
    "\n    at run (/private/" +
    secret +
    "/skills-library-import-authority.real-gateway.e2e.test.ts:741:19)";
  const facts = classifySkillProofFailure(error);
  expect(facts.assertionLocations).toEqual([
    { file: "skills-library-import-authority.real-gateway.e2e.test.ts", line: 741, column: 19 },
  ]);
  expect(JSON.stringify(facts)).not.toContain(secret);
  expect(JSON.stringify(facts)).not.toContain("/private/");
});
