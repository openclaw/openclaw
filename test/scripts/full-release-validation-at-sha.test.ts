import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertTrustedWorkflowHarness,
  dispatchInputsDigest,
  parseArgs,
  releaseProfileForVersion,
  releaseDecisionStopsForeground,
  releaseEvidenceVerificationArgs,
  releaseEvidenceVerifierPath,
  resolveRemoteTargetRefSha,
  shouldDeleteTemporaryWorkflowRef,
  tryReadReleaseDecision,
  validateReleaseDecisionPayload,
  verifyTargetRef,
  verifyTrustedWorkflowRef,
} from "../../scripts/full-release-validation-at-sha.mts";
import {
  CURRENT_WORKFLOW_SOURCE,
  CONTRACT_ONE_WORKFLOW_SOURCE,
  LEGACY_WORKFLOW_SOURCE,
  runGit,
  createDispatchFixture,
  ghApiEndpoint,
  ghApiMethod,
  isWorkflowDispatch,
  ghField,
} from "./full-release-validation-at-sha.test-support.js";

describe("full-release-validation-at-sha", () => {
  it("rejects a missing purpose before remote creation on supporting tooling", () => {
    const fixture = createDispatchFixture({ omitPurpose: true });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/validation_purpose/u);
    expect(fixture.calls("POST")).toEqual([]);
  });

  it("reopens historical identity-only retained inputs without adding source intent or rewriting bytes", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const record = fixture.record();
    const envelope = JSON.parse(record.request.wireInputs.trusted_workflow_json);
    const legacyIdentity = JSON.stringify(envelope.trustedWorkflow, null, 1);
    record.request.inputs.trusted_workflow_json = legacyIdentity;
    record.request.wireInputs.trusted_workflow_json = legacyIdentity;
    writeFileSync(fixture.requestPath(), JSON.stringify(record) + "\n");
    const accepted = JSON.parse(readFileSync(fixture.acceptedRunPath, "utf8"));
    accepted.inputs.trusted_workflow_json = legacyIdentity;
    writeFileSync(fixture.acceptedRunPath, JSON.stringify(accepted));
    const before = readFileSync(fixture.requestPath());
    const callsBefore = fixture.calls().length;
    const reopened = fixture.run(["--reconcile-request", fixture.requestPath()], true);
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(readFileSync(fixture.requestPath())).toEqual(before);
    expect(
      fixture
        .calls()
        .slice(callsBefore)
        .every((args) => ghApiMethod(args) === "GET"),
    ).toBe(true);
    const relabeled = fixture.run(
      ["--request-file", fixture.requestPath(), "-f", "validation_purpose=diagnostic"],
      true,
    );
    expect(relabeled.status).toBe(1);
    expect(readFileSync(fixture.requestPath())).toEqual(before);
  });

  it("normalizes GitHub witness inputs without depending on omitted blanks, order, or Boolean representation", () => {
    expect(dispatchInputsDigest({ text: "a=b\n$()", count: 3, flag: false, empty: "" })).toBe(
      dispatchInputsDigest({ empty: "", flag: "false", count: "3", text: "a=b\n$()" }),
    );
    expect(dispatchInputsDigest({ flag: true })).not.toBe(dispatchInputsDigest({ flag: false }));
    expect(dispatchInputsDigest({ flag: "" })).toBe(dispatchInputsDigest({}));
  });

  it("parses release validation dispatch args", () => {
    expect(
      parseArgs([
        "--sha",
        "abc123",
        "--workflow-sha",
        "a".repeat(40),
        "--trusted-workflow-ref",
        `release-publish/${"a".repeat(12)}-123`,
        "--target-ref",
        "release/2026.7.1",
        "--keep-branch",
        "--dry-run",
        "-f",
        "provider=anthropic",
        "--",
        "mode=linux",
      ]),
    ).toMatchObject({
      dryRun: true,
      keepBranch: true,
      inputs: {
        mode: "linux",
        provider: "anthropic",
        reuse_evidence: "true",
        fail_fast: "false",
      },
      sha: "abc123",
      targetRef: "release/2026.7.1",
      trustedWorkflowRef: `release-publish/${"a".repeat(12)}-123`,
      workflowSha: "a".repeat(40),
    });
  });

  it("accepts documented -f assignments after the option separator", () => {
    expect(
      parseArgs(["--", "-f", "release_profile=full", "-fmode=linux", "provider=anthropic"]).inputs,
    ).toMatchObject({
      mode: "linux",
      provider: "anthropic",
      release_profile: "full",
    });
    expect(() => parseArgs(["--", "-f"])).toThrow("-f requires a value");
  });

  it("requires an exact Tooling SHA for protected workflow tags", () => {
    const trustedTag = `release-publish/${"a".repeat(12)}-123`;
    expect(() => parseArgs(["--trusted-workflow-ref", trustedTag])).toThrow(
      "explicit full Tooling SHA",
    );
    expect(() =>
      parseArgs(["--workflow-sha", "a".repeat(40), "--trusted-workflow-ref", "release/2026.8.1"]),
    ).toThrow("protected release-publish");
  });

  it("rejects retry groups that are not controller APIs", () => {
    expect(() => parseArgs(["-f", "rerun_group=release-checks"])).toThrow(
      "rerun_group must be one of",
    );
    expect(() => parseArgs(["-f", "rerun_group=qa"])).toThrow("rerun_group must be one of");
    expect(parseArgs(["-f", "rerun_group=qa-parity"]).inputs.rerun_group).toBe("qa-parity");
  });

  it("infers the release profile from the target package version", () => {
    expect(releaseProfileForVersion("2026.7.1-beta.4")).toBe("beta");
    expect(() => releaseProfileForVersion("2026.7.1-alpha.4")).toThrow(
      "Alpha releases are retired;",
    );
    expect(releaseProfileForVersion("2026.7.1")).toBe("stable");
    expect(releaseProfileForVersion("2026.7.1-1")).toBe("stable");
  });

  it("rejects missing option values", () => {
    expect(() => parseArgs(["--sha", "--dry-run"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--sha", "-h"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--workflow-sha", "--dry-run"])).toThrow(
      "--workflow-sha requires a value",
    );
    expect(() => parseArgs(["--workflow-sha", "-h"])).toThrow("--workflow-sha requires a value");
    expect(() => parseArgs(["--target-ref", "--dry-run"])).toThrow("--target-ref requires a value");
    expect(() => parseArgs(["-f", "--dry-run"])).toThrow("-f requires a value");
    expect(() => parseArgs(["-f", "-h"])).toThrow("-f requires a value");
  });

  it("accepts only canonical release branch or tag context", () => {
    expect(
      parseArgs(["--target-ref", "extended-stable/2026.6.33", "--workflow-sha", "a".repeat(40)])
        .targetRef,
    ).toBe("extended-stable/2026.6.33");
    expect(parseArgs(["--target-ref", "v2026.7.1-beta.5"]).targetRef).toBe("v2026.7.1-beta.5");
    expect(parseArgs(["--target-ref", "v2026.7.1"]).targetRef).toBe("v2026.7.1");
    expect(parseArgs(["--target-ref", "refs/tags/v2026.7.1-2"]).targetRef).toBe("v2026.7.1-2");
    expect(
      parseArgs(["--target-ref", "refs/heads/release/2026.7.1-2", "--workflow-sha", "a".repeat(40)])
        .targetRef,
    ).toBe("release/2026.7.1-2");
    for (const ref of [
      "feature/not-release",
      "release/2026.6.33-1",
      "v2026.6.33-1",
      "release/2026.7.1-beta.2",
      "refs/tags/release/2026.7.1",
      "refs/heads/v2026.7.1",
    ]) {
      expect(() => parseArgs(["--target-ref", ref])).toThrow(
        "canonical OpenClaw release branch or tag",
      );
    }
    expect(parseArgs(["--target-ref", "release/2026.7.1"])).toMatchObject({
      trustedWorkflowRef: "candidate",
      workflowSha: "",
      admissionWorkflowRef: "main",
    });
    expect(() =>
      parseArgs(["--target-ref", "release/2026.7.1", "--trusted-workflow-ref", "main"]),
    ).toThrow("requires --workflow-sha with an explicit full Tooling SHA");
    expect(() =>
      parseArgs(["--target-ref", "release/2026.7.1", "--workflow-sha", "origin/main"]),
    ).toThrow("explicit full Tooling SHA");
  });

  it("requires a same-source base tag only when a correction uses base-version packages", () => {
    const targetSha = "a".repeat(40);
    for (const ref of ["release/2026.7.1-2", "v2026.7.1-2"]) {
      const resolveRef = (baseSha: string) => (requested: string) =>
        requested === "v2026.7.1" ? baseSha : targetSha;
      for (const baseSha of ["", "b".repeat(40)]) {
        expect(() =>
          verifyTargetRef(ref, targetSha, "2026.7.1", resolveRef(baseSha), () => true),
        ).toThrow("must use the same source commit as v2026.7.1");
      }
      expect(verifyTargetRef(ref, targetSha, "2026.7.1-2", resolveRef(""), () => true)).toBe(ref);
      for (const packageVersion of ["2026.7.2", "2026.7.1-beta.2", "2026.7.1-1"]) {
        expect(() =>
          verifyTargetRef(ref, targetSha, packageVersion, resolveRef(targetSha), () => true),
        ).toThrow("does not match release tag");
      }
    }
  });

  it("resolves annotated release tags through their peeled commit", () => {
    const calls: string[][] = [];
    const sha = resolveRemoteTargetRefSha("v2026.7.1-beta.5", (args) => {
      calls.push(args);
      return `b6387afd6d2e0f43c2ae98d2d124dbc277f03cca\t${args.at(-1)}`;
    });
    expect(sha).toBe("b6387afd6d2e0f43c2ae98d2d124dbc277f03cca");
    expect(calls).toEqual([["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1-beta.5^{}"]]);
  });

  it("falls back to the direct ref for lightweight release tags", () => {
    const calls: string[][] = [];
    const sha = resolveRemoteTargetRefSha("v2026.7.1", (args) => {
      calls.push(args);
      return args.at(-1)?.endsWith("^{}")
        ? ""
        : "0123456789abcdef0123456789abcdef01234567\trefs/tags/v2026.7.1";
    });
    expect(sha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(calls).toEqual([
      ["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1^{}"],
      ["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1"],
    ]);
  });

  it("binds frozen release candidates to the branch or tag package version", () => {
    const candidateSha = "a".repeat(40);
    const branchTipSha = "b".repeat(40);
    const verify = (ref: string, version: string, remote = branchTipSha, reachable = true) =>
      verifyTargetRef(
        ref,
        candidateSha,
        version,
        () => remote,
        (ancestor, descendant) => reachable && ancestor === candidateSha && descendant === remote,
      );
    expect(verify("release/2026.7.1", "2026.7.1-beta.5")).toBe("release/2026.7.1");
    expect(() => verify("release/2026.7.1", "2026.7.1-alpha.5")).toThrow(
      "expected 2026.7.1 or a beta prerelease of it",
    );
    expect(() => verify("release/2026.7.1", "2026.7.1", branchTipSha, false)).toThrow(
      "is not reachable from release branch",
    );
    expect(() => verify("release/2026.7.1", "2026.6.9")).toThrow(
      "does not belong to release branch",
    );
    for (const version of ["2026.6.33", "2026.6.34", "2026.6.35"]) {
      expect(verify("extended-stable/2026.6.33", version)).toBe("extended-stable/2026.6.33");
    }
    for (const version of ["2026.6.32", "2026.7.35", "2026.6.35-beta.1", "2026.6.35-1"]) {
      expect(() => verify("extended-stable/2026.6.33", version)).toThrow(
        "does not belong to extended-stable branch",
      );
    }
    expect(verify("v2026.7.1-beta.5", "2026.7.1-beta.5", candidateSha, false)).toBe(
      "v2026.7.1-beta.5",
    );
    expect(() => verify("v2026.7.1-beta.5", "2026.7.1-beta.5")).toThrow("does not resolve");
    expect(() => verify("v2026.7.1-beta.5", "2026.7.1-beta.4", candidateSha)).toThrow(
      "does not match release tag",
    );
  });

  it("allows exact-target reuse to be disabled for a forced fresh run", () => {
    expect(parseArgs(["-f", "reuse_evidence=false"]).inputs.reuse_evidence).toBe("false");
    expect(() => parseArgs(["-f", "reuse_evidence=maybe"])).toThrow(
      "reuse_evidence must be true or false",
    );
    expect(parseArgs(["-f", "fail_fast=true"]).inputs.fail_fast).toBe("true");
    expect(() => parseArgs(["-f", "fail_fast=maybe"])).toThrow("fail_fast must be true or false");
    expect(() => parseArgs(["-f", "release_profile=minimum"])).toThrow(
      "release_profile must be beta, stable, or full",
    );
    expect(() => parseArgs(["-f", "allow_unreleased_changelog=maybe"])).toThrow(
      "allow_unreleased_changelog must be true or false",
    );
  });

  it("reserves immutable candidate identity inputs for the resolved --sha", () => {
    expect(() => parseArgs(["-f", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["--", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["-f", `expected_sha=${"a".repeat(40)}`])).toThrow(
      "reserves expected_sha",
    );
    expect(() => parseArgs(["--", `expected_sha=${"a".repeat(40)}`])).toThrow(
      "reserves expected_sha",
    );
    expect(() => parseArgs(["-f", "trusted_workflow_json={}"])).toThrow(
      "reserves trusted_workflow_json",
    );
  });

  it("validates direct and reused runs through the strict evidence verifier", () => {
    const workflowSha = "a".repeat(40);
    const verifier = "/tmp/trusted/scripts/release-ci-summary.mjs";
    expect(releaseEvidenceVerificationArgs("123", workflowSha, verifier)).toEqual([
      "--validate-run",
      "123",
      "--trusted-workflow-ref",
      "main",
      "--trusted-workflow-full-ref",
      "refs/heads/main",
      "--trusted-workflow-sha",
      workflowSha,
      "--json",
      "--verifier-source-sha",
      workflowSha,
      "--verifier-source-file",
      verifier,
    ]);
    expect(() => releaseEvidenceVerificationArgs("", workflowSha, verifier)).toThrow(
      "positive decimal",
    );
    const trustedTag = `release-publish/${workflowSha.slice(0, 12)}-123`;
    expect(releaseEvidenceVerificationArgs("123", workflowSha, verifier, trustedTag)).toEqual([
      "--validate-run",
      "123",
      "--trusted-workflow-ref",
      trustedTag,
      "--trusted-workflow-full-ref",
      `refs/tags/${trustedTag}`,
      "--trusted-workflow-sha",
      workflowSha,
      "--json",
      "--verifier-source-sha",
      workflowSha,
      "--verifier-source-file",
      verifier,
    ]);
    expect(() =>
      releaseEvidenceVerificationArgs("123", workflowSha, verifier, "release/2026.8.1"),
    ).toThrow("protected release-publish tag");
  });

  it("accepts only exact protected workflow tags outside main ancestry", () => {
    const sha = "a".repeat(40);
    const tag = `release-publish/${sha.slice(0, 12)}-123`;
    const verify = (ref: string, remote = "", mainAncestor = false) =>
      verifyTrustedWorkflowRef(
        sha,
        ref,
        () => remote,
        () => mainAncestor,
      );
    expect(() => verify("main", "", true)).not.toThrow();
    expect(() => verify("main")).toThrow("not reachable from current origin/main");
    expect(() => verify(tag, sha)).not.toThrow();
    expect(() => verify(`release-publish/${"b".repeat(12)}-123`, sha)).toThrow(
      "does not match Tooling SHA",
    );
    expect(() => verify(tag)).toThrow("does not exist on origin");
    expect(() => verify(tag, "c".repeat(40))).toThrow(`expected ${sha}`);
    expect(() => verify("release/2026.8.1", sha)).toThrow("protected release-publish");
  });

  it("bounds run discovery with backoff through cached registration lag", () => {
    const fixture = createDispatchFixture({
      runDiscoveryMisses: 4,
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not determine Full Release Validation run id:");
    expect(fixture.readWaits()).toEqual([30_000, 60_000, 120_000]);
    const calls = fixture.calls();
    expect(
      calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/workflows/17/runs")),
    ).toHaveLength(4);
  });

  it("keeps waiting while the exact run is queued before its witness upload", () => {
    const queued = { conclusion: null, status: "queued" };
    const fixture = createDispatchFixture({
      parentRunStates: [
        ...Array.from({ length: 6 }, () => queued),
        { conclusion: "success", status: "completed" },
      ],
      witnessMissingReads: 6,
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("dispatch=pending-witness: run 123 (queued)");
    expect(fixture.readWaits()).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
    expect(fixture.record()).toMatchObject({
      phase: "observed",
      run: { id: 123, attempt: 1 },
    });
  });

  it("delivers the complete wire body through a private, bounded, short-lived payload", () => {
    const fixture = createDispatchFixture();
    const value = "spaces 'quotes' \"double\" = & ? $() `command`\n\u00e9\u65e5\u672c";
    const result = fixture.run([
      "-f",
      `live_suite_filter=${value}`,
      "-f",
      "run_release_soak=true",
      "-f",
      "reuse_evidence=false",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const payload = fixture.readPayload();
    const intent = fixture.record();
    expect(payload.body).toEqual({
      ref: intent.request.workflowRef,
      inputs: intent.request.wireInputs,
    });
    expect(payload.body.inputs).toMatchObject({
      live_suite_filter: value,
      cross_os_suite_filter: "",
      run_release_soak: "true",
      reuse_evidence: "false",
    });
    expect(Object.values(payload.body.inputs).every((input) => typeof input === "string")).toBe(
      true,
    );
    expect(payload.bytes).toBe(Buffer.byteLength(JSON.stringify(payload.body)));
    expect(payload.bytes).toBeGreaterThan(JSON.stringify(payload.body).length);
    expect(payload.bytes).toBeLessThanOrEqual(128 * 1024);
    expect(payload).toMatchObject({ regularFile: true, fileMode: 0o600, directoryMode: 0o700 });
    const calls = fixture.calls();
    expect(calls.filter(isWorkflowDispatch)).toEqual([
      [
        "api",
        "--include",
        "--method",
        "POST",
        "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/dispatches",
        "--hostname",
        "github.com",
        "--input",
        payload.path,
      ],
    ]);
    expect(JSON.stringify(calls)).not.toContain(value);
    expect(result.stdout + result.stderr).not.toContain(value);
    const events = fixture.readPayloadEvents();
    expect(events.slice(0, 4).map((event) => event.stage)).toEqual([
      "created",
      "write",
      "post",
      "cleanup",
    ]);
    expect(events[1]?.options).toEqual({ flag: "wx", mode: 0o600 });
    expect(events[4]?.stage).toBe("reconcile");
    expect(existsSync(payload.path)).toBe(false);
    expect(existsSync(payload.directory)).toBe(false);
    expect(intent).toMatchObject({
      phase: "observed",
      error: "none",
      run: { id: 123, attempt: 1 },
    });
  });

  it("does not mutate remote refs when payload write preparation fails", () => {
    const fixture = createDispatchFixture({ payloadPreparationFailure: "write" });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected payload write failure");
    expect(fixture.calls().filter((call) => ghApiMethod(call) !== "GET")).toEqual([]);
    expect(fixture.gitCalls().filter((call) => call[0] === "push")).toEqual([]);
    expect(fixture.record()).toMatchObject({
      phase: "prepared",
      error: "none",
      run: null,
      refs: { workflow: "intended" },
    });
    const events = fixture.readPayloadEvents();
    expect(events.map((event) => event.stage)).toEqual(["created", "write", "cleanup"]);
    for (const event of events) {
      expect(existsSync(event.path)).toBe(false);
    }
  });

  it("rejects oversized UTF-8 inputs before payload preparation or remote mutation", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run(["-f", `live_suite_filter=${"\u00e9".repeat(34_000)}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Dispatch request exceeds its byte limit");
    expect(fixture.readPayloadEvents()).toEqual([]);
    expect(fixture.calls().filter((call) => ghApiMethod(call) !== "GET")).toEqual([]);
    expect(fixture.gitCalls().filter((call) => call[0] === "push")).toEqual([]);
  });

  it.each([
    {
      name: "unknown transport",
      options: { dispatchFailure: true },
      status: 1,
      phase: "attempted",
      error: "unclassified",
      deleted: 0,
    },
    {
      name: "accepted response loss",
      options: { acceptedDispatchFailure: true },
      status: 0,
      phase: "observed",
      error: "transport",
      deleted: 1,
    },
  ])(
    "preserves $name despite payload cleanup failure",
    ({ options, status, phase, error, deleted }) => {
      const fixture = createDispatchFixture({ ...options, payloadCleanupFailure: true });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(status);
      const payload = fixture.readPayload();
      expect(existsSync(payload.path)).toBe(true);
      expect(result.stderr).toContain(
        `Could not remove dispatch payload directory: ${JSON.stringify(payload.directory)}`,
      );
      expect(result.stderr).not.toContain("private-cleanup-error-must-not-be-logged");
      expect(fixture.record()).toMatchObject({
        phase,
        error,
      });
      const calls = fixture.calls();
      expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
      expect(calls.filter((call) => ghApiMethod(call) === "DELETE")).toHaveLength(deleted);
      expect(fixture.refs()).toHaveLength(1 - deleted);
      const stages = fixture.readPayloadEvents().map((event) => event.stage);
      expect(stages.slice(0, 4)).toEqual(["created", "write", "post", "cleanup"]);
      expect(stages[4]).toBe("reconcile");
    },
  );

  it("rejects a run from an unrelated workflow event", () => {
    const fixture = createDispatchFixture({ runIdentityOverrides: { event: "push" } });
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).not.toContain("ok release evidence");
    expect(fixture.calls("DELETE")).toEqual([]);
  });

  it.each([
    {
      name: "packed lane",
      marker: "FULL_RELEASE_LANE_INPUTS_CONTRACT",
      input: 'extension_test_exclude_patterns_json=["extensions/example/src/example.test.ts"]',
      error: "does not support packed lane inputs",
    },
    {
      name: "declared flake",
      marker: undefined,
      input: 'known_flaky_jobs_json=["normalCi:checks-node"]',
      error: "Automatic test retries are disabled",
    },
  ])(
    "refuses unsupported $name controls before creating refs or dispatching",
    ({ marker, input, error }) => {
      const fixture = createDispatchFixture({
        workflowSource: marker
          ? CURRENT_WORKFLOW_SOURCE.replace(`  ${marker}: "1"\n`, "")
          : CURRENT_WORKFLOW_SOURCE,
      });
      const result = fixture.run(["-f", input]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(fixture.calls()).toEqual([]);
    },
  );

  it("rejects obsolete retained target-ref fields before Git or remote access", () => {
    const fixture = createDispatchFixture();
    expect(fixture.run().status).toBe(0);
    const path = fixture.requestPath();
    const record = JSON.parse(readFileSync(path, "utf8"));
    const ghCalls = readFileSync(fixture.ghCallsPath, "utf8");
    const gitCalls = readFileSync(fixture.gitCallsPath, "utf8");
    for (const fields of ["request", "refs", "both"]) {
      const legacy = {
        ...record,
        request: {
          ...record.request,
          ...(fields !== "refs"
            ? { targetRef: `validation/target-${fixture.targetSha.slice(0, 12)}-123` }
            : {}),
        },
        refs: { ...record.refs, ...(fields !== "request" ? { target: "created" } : {}) },
      };
      const bytes = `${JSON.stringify(legacy)}\n`;
      writeFileSync(path, bytes);
      const result = fixture.run(["--reconcile-request", path], true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        fields === "refs"
          ? "Invalid retained dispatch outcome"
          : "Invalid retained dispatch request identity",
      );
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
    expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe(ghCalls);
    expect(readFileSync(fixture.gitCallsPath, "utf8")).toBe(gitCalls);
  });

  it.each(["missing", "truncated", "oversized", "symlink", "parent symlink", "public"] as const)(
    "refuses a %s request before any remote or Git access",
    (kind) => {
      const fixture = createDispatchFixture();
      let path = join(fixture.checkout, "request.json");
      if (kind === "truncated") {
        writeFileSync(path, '{"kind":', { mode: 0o600 });
      } else if (kind === "oversized") {
        writeFileSync(path, "x".repeat(129 * 1024), { mode: 0o600 });
      } else if (kind === "symlink") {
        symlinkSync(join(fixture.checkout, "missing.json"), path);
      } else if (kind === "parent symlink") {
        symlinkSync(fixture.checkout, join(fixture.checkout, "linked"));
        path = join(fixture.checkout, "linked", "request.json");
      } else if (kind === "public") {
        writeFileSync(path, "{}\n", { mode: 0o644 });
      }
      const result = fixture.run(["--reconcile-request", path], true);
      expect(result.status).toBe(1);
      expect(fixture.calls()).toEqual([]);
      expect(fixture.gitCalls()).toEqual([]);
    },
  );

  it("refuses witness-incapable frozen tooling before remote creation", () => {
    const fixture = createDispatchFixture({
      workflowSource: CURRENT_WORKFLOW_SOURCE.replace(
        '  FULL_RELEASE_DISPATCH_WITNESS_CONTRACT: "1"\n',
        "",
      ),
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Tooling SHA ${fixture.workflowSha} does not support FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1`,
    );
    expect(fixture.calls()).toEqual([]);
    expect(fixture.gitCalls().some((args) => args[0] === "push")).toBe(false);
    expect(fixture.refs()).toEqual([]);
  });

  it.each([
    {
      name: "intent write fails",
      options: { failIntentWrite: true },
      status: 1,
      phase: "prepared",
    },
    {
      name: "process exits before POST",
      options: { stopBeforeDispatch: true },
      status: 77,
      phase: "attempted",
    },
  ])("does not redispatch when $name", ({ options, status, phase }) => {
    const fixture = createDispatchFixture(options);
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(status);
    const path = fixture.requestPath();
    expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe(phase);
    const before = readFileSync(path, "utf8");
    const recovery = fixture.run(["--reconcile-request", path], true);
    expect(recovery.status).toBe(1);
    expect(recovery.stderr).toContain("dispatch=unknown");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(fixture.dispatches()).toEqual([]);
  });

  it("allows only the claimed caller to POST when another caller reopens concurrently", () => {
    const fixture = createDispatchFixture({ reopenDuringDispatch: true });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.dispatches()).toHaveLength(1);
  });

  it.each([{ ghRoute: "path" as const, tokenPresent: false }])(
    "reads witness bytes through $ghRoute CLI without Node fetch (token=$tokenPresent)",
    ({ ghRoute, tokenPresent }) => {
      const fixture = createDispatchFixture({
        archiveEscapeFlag: "required",
        ghRoute,
        tokenPresent,
      });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      const calls = fixture.calls();
      expect(calls.filter((args) => args[0] === "auth")).toEqual([]);
      expect(readFileSync(fixture.fetchCallsPath, "utf8")).toBe("");
      const reads = readFileSync(fixture.artifactTransportPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(reads).toHaveLength(2);
      expect(reads[0]).toMatchObject({ timeout: 60_000, maxBuffer: 128 * 1024 });
      expect(reads[1]).toMatchObject({
        encoding: null,
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
      for (const { args } of reads) {
        expect(ghApiMethod(args)).toBe("GET");
        expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
        expect(args).toContain("Cache-Control: max-age=0");
        expect(args).not.toContain("--include");
      }
      expect(ghApiEndpoint(reads[0].args)).toBe("repos/openclaw/openclaw/actions/artifacts/9001");
      expect(ghApiEndpoint(reads[1].args)).toBe(
        "repos/openclaw/openclaw/actions/artifacts/9001/zip",
      );
      expect(reads[1].args).toContain("--allow-escape-sequences");
      expect(fixture.readCalls(fixture.pathGhCallsPath)).toEqual(ghRoute === "path" ? calls : []);
      expect(fixture.record().phase).toBe("observed");
    },
  );

  it("falls back once when gh does not support the binary-output flag", () => {
    const fixture = createDispatchFixture({ archiveEscapeFlag: "unsupported" });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const archiveReads = readFileSync(fixture.artifactTransportPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ args }) => ghApiEndpoint(args).endsWith("/zip"));
    expect(archiveReads).toHaveLength(2);
    expect(archiveReads[0].args).toContain("--allow-escape-sequences");
    expect(archiveReads[1].args).not.toContain("--allow-escape-sequences");
  });

  it("does not retry unrelated witness archive failures", () => {
    const fixture = createDispatchFixture({
      archiveEscapeFlag: "required",
      artifactReadError: "archive",
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dispatch=unknown");
    const archiveReads = readFileSync(fixture.artifactTransportPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ args }) => ghApiEndpoint(args).endsWith("/zip"));
    expect(archiveReads).toHaveLength(1);
    expect(archiveReads[0].args).toContain("--allow-escape-sequences");
  });

  it.each([
    { name: "nonpositive ID", artifactMetadata: { id: 0 } },
    { name: "oversized declaration", artifactMetadata: { size_in_bytes: 256 * 1024 + 1 } },
    { name: "invalid digest", artifactMetadata: { digest: "sha256:invalid" } },
    { name: "expired flag", artifactMetadata: { expired: true } },
    { name: "elapsed expiry", artifactMetadata: { expires_at: "2000-01-01T00:00:00Z" } },
    {
      name: "changed SHA",
      exactArtifactMetadata: { workflow_run: { id: 123, head_sha: "c".repeat(40) } },
    },
    { name: "oversized metadata", oversizedArtifactMetadata: true },
    { name: "oversized archive", archiveFailure: "oversized" as const },
    { name: "corrupt ZIP with matching digest", archiveFailure: "corrupt" as const },
    { name: "mismatched archive digest", archiveFailure: "digest" as const },
  ])("refuses witness $name without fallback or remote cleanup", ({ name: _name, ...options }) => {
    const fixture = createDispatchFixture({
      ...options,
      ghRoute: "path",
      tokenPresent: false,
    });
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain("dispatch=unknown");
    expect(result.stdout).not.toContain("ok release evidence");
    const calls = fixture.calls();
    expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
    expect(calls.filter((args) => ghApiMethod(args) === "DELETE")).toEqual([]);
    expect(calls.filter((args) => args[0] === "auth")).toEqual([]);
    expect(readFileSync(fixture.fetchCallsPath, "utf8")).toBe("");
    expect(fixture.record().phase).toBe("attempted");
    expect(fixture.refs()).toHaveLength(1);
  });

  it.each(["full-ref"] as const)(
    "accepts the %s exact workflow path representation",
    (runPathStyle) => {
      const fixture = createDispatchFixture({ runPathStyle });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.record()).toMatchObject({
        phase: "observed",
        run: { id: 123, attempt: 1 },
      });
      expect(fixture.dispatches()).toHaveLength(1);
    },
  );

  it.each([
    { name: "second-page duplicate", options: { duplicateOnSecondPage: true } },
    {
      name: "missing next page",
      options: { duplicateOnSecondPage: true, incompletePagination: true },
    },
    { name: "missing witness", options: { witnessMissing: true } },
    { name: "duplicate witness", options: { witnessDuplicate: true } },
    {
      name: "wrong repository",
      options: { runIdentityOverrides: { repository: { full_name: "example/other" } } },
    },
    {
      name: "foreign full-ref suffix",
      options: {
        runIdentityOverrides: {
          path: ".github/workflows/full-release-validation.yml@refs/heads/main",
        },
      },
    },
    { name: "wrong tooling SHA", options: { runIdentityOverrides: { head_sha: "c".repeat(40) } } },
    { name: "wrong transport", options: { runIdentityOverrides: { head_branch: "main" } } },
  ])("leaves $name unresolved without verification or cleanup", ({ options }) => {
    const fixture = createDispatchFixture(options);
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain("dispatch=unknown");
    expect(result.stdout).not.toContain("ok release evidence");
    const calls = fixture.calls();
    expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
    expect(calls.filter((args) => ghApiMethod(args) === "DELETE")).toEqual([]);
    if (options.duplicateOnSecondPage && !options.incompletePagination) {
      expect(calls.some((args) => ghField(args, "page") === "2")).toBe(true);
    }
  });

  it.each(["provider"])("does not adopt a run with a different %s input witness", (key) => {
    const fixture = createDispatchFixture({ witnessInputs: { [key]: "__different_input__" } });
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(
      "Dispatch input witness does not match the complete retained request",
    );
    expect(fixture.calls("DELETE")).toEqual([]);
  });

  it.each([
    ["beta", false],
    ["full", true],
  ] as const)(
    "retains raw defaults separately from effective %s soak",
    (profile, effectiveSoak) => {
      const fixture = createDispatchFixture();
      const result = fixture.run(["-f", `release_profile=${profile}`]);
      expect(result.status, result.stderr).toBe(0);
      const record = fixture.record();
      expect(record.request).toMatchObject({
        effectiveSoak,
        inputs: {
          run_release_soak: false,
          fail_fast: false,
          reuse_evidence: true,
          live_suite_filter: "",
          cross_os_suite_filter: "",
        },
        wireInputs: { run_release_soak: "false", fail_fast: "false", reuse_evidence: "true" },
      });
      expect(record.run).toEqual({ id: 123, attempt: 1 });
      expect(record.error).toBe("none");
    },
  );

  it.each([422])(
    "retains HTTP %s rejection without adopting or redispatching",
    (dispatchHttpStatus) => {
      const fixture = createDispatchFixture({ dispatchHttpStatus });
      const result = fixture.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dispatch=rejected");
      const path = fixture.requestPath();
      expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe("rejected");
      const calls = readFileSync(fixture.ghCallsPath, "utf8");
      const recovery = fixture.run(["--reconcile-request", path], true);
      expect(recovery.status).toBe(1);
      expect(recovery.stderr).toContain("dispatch=rejected");
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe(calls);
    },
  );

  it("does not retain or mutate a request in dry-run mode", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run(["--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("(dry run; not written)");
    expect(result.stdout).toContain(`Validation SHA fetchable by bare SHA: ${fixture.targetSha}`);
    expect(result.stdout).not.toContain("validation/target-");
    const fetch = fixture
      .gitCalls()
      .find((args) => args.includes("https://github.com/openclaw/openclaw.git"));
    expect(fetch).toEqual([
      "-C",
      expect.any(String),
      "fetch",
      "--no-tags",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/openclaw/openclaw.git",
      fixture.targetSha,
    ]);
    expect(fetch![1]).not.toBe(fixture.checkout);
    expect(existsSync(fetch![1]!)).toBe(false);
    expect(runGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(fixture.readPayloadEvents()).toEqual([]);
    expect(fixture.calls()).toEqual([]);
    expect(fixture.gitCalls().some((args) => args[0] === "push")).toBe(false);
  });

  it("binds release decisions to the exact parent attempt and tooling SHA", () => {
    const payload = {
      kind: "openclaw.full-release-decision",
      mode: "decision",
      parentRunAttempt: 2,
      sourceParentRunAttempt: 1,
      parentRunId: "123",
      activeRunIds: ["101"],
      blockers: [{ child: "normalCi", job: "test", runId: "101" }],
      cancellation: { cancelledRunIds: [], requested: false },
      children: {},
      errors: [],
      executionPlanSha256: "c".repeat(64),
      releaseProfile: "stable",
      rerunGroup: "ci",
      state: "blocked_diagnostics_running",
      targetSha: "b".repeat(40),
      version: 2,
      workflowRef: "main",
      workflowSha: "a".repeat(40),
    };
    expect(
      validateReleaseDecisionPayload(payload, {
        parentRunAttempt: 2,
        parentRunId: "123",
        workflowSha: "a".repeat(40),
      }),
    ).toMatchObject(payload);
    expect(releaseDecisionStopsForeground("blocked_diagnostics_running")).toBe(true);
    expect(releaseDecisionStopsForeground("passed")).toBe(false);
    expect(() =>
      validateReleaseDecisionPayload(
        { ...payload, parentRunAttempt: 3 },
        {
          parentRunAttempt: 2,
          parentRunId: "123",
          workflowSha: "a".repeat(40),
        },
      ),
    ).toThrow("binding is invalid");
  });

  it("treats only transient Release Decision download failures as unavailable this poll", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: "HTTP 503: Server Error",
          stdout: "",
        })),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Release Decision artifact unavailable this poll"),
      );
      expect(() =>
        tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: "HTTP 403: Bad credentials",
          stdout: "",
        })),
      ).toThrow("Release Decision artifact download failed");
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["no valid artifacts found to download"])(
    "treats missing named Release Decision artifacts as unavailable: %s",
    (stderr) => {
      expect(
        tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr,
          stdout: "",
        })),
      ).toBeUndefined();
    },
  );

  it("rejects incomplete trusted release harnesses before dispatch", () => {
    const workflowPath = ".github/workflows/full-release-validation.yml";
    const verifierPath = "scripts/release-ci-summary.mjs";
    const checked: string[] = [];
    expect(
      assertTrustedWorkflowHarness(
        "a".repeat(40),
        (relativePath) => {
          checked.push(relativePath);
          return relativePath === workflowPath || relativePath === verifierPath;
        },
        () => CURRENT_WORKFLOW_SOURCE,
      ),
    ).toEqual({ contract: "2", verifierPath });
    expect(checked).toEqual([workflowPath, verifierPath]);
    expect(() => assertTrustedWorkflowHarness("a".repeat(40), () => false)).toThrow(workflowPath);
    expect(() =>
      assertTrustedWorkflowHarness(
        "a".repeat(40),
        (relativePath) => relativePath === workflowPath,
        () => CURRENT_WORKFLOW_SOURCE,
      ),
    ).toThrow("supported release evidence verifier");
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () => LEGACY_WORKFLOW_SOURCE,
      ),
    ).toThrow("does not declare a supported RELEASE_ISOLATION_TOOLING_CONTRACT");
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () =>
          'env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\non:\n  workflow_dispatch:\n    inputs: {}\n',
      ),
    ).toThrow(`Tooling SHA ${"b".repeat(40)} is missing workflow_dispatch input expected_sha`);
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () =>
          'env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\non:\n  workflow_dispatch:\n    inputs:\n      expected_sha: {}\n',
      ),
    ).toThrow("missing workflow_dispatch input trusted_workflow_json");
    expect(
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () => CONTRACT_ONE_WORKFLOW_SOURCE,
      ),
    ).toEqual({ contract: "1", verifierPath });
  });

  it("retains a failed parent workflow ref for GitHub reruns", () => {
    const shouldDelete = (parentConclusion: string, evidenceVerified = false, dryRun = false) =>
      shouldDeleteTemporaryWorkflowRef({
        parentConclusion,
        evidenceVerified,
        dryRun,
        keepBranch: false,
      });
    expect(shouldDelete("failure")).toBe(false);
    expect(shouldDelete("success", true)).toBe(true);
    expect(shouldDelete("", false, true)).toBe(true);
    expect(shouldDelete("success")).toBe(false);
  });

  it("rejects missing version notes before creating remote refs or dispatching", () => {
    const fixture = createDispatchFixture({
      targetSource: { "CHANGELOG.md": "## 2026.7.9\n\nAn older release with substantive notes.\n" },
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not contain a release section for 2026.8.1");
    expect(fixture.gitCalls().filter((call) => call[0] === "push")).toEqual([]);
    expect(fixture.calls().filter((call) => ghApiMethod(call) !== "GET")).toEqual([]);
    expect(fixture.dispatches()).toEqual([]);
  });

  it("dispatches a frozen correction candidate and removes only its workflow ref", () => {
    const fixture = createDispatchFixture();
    const releaseRef = `${fixture.releaseRef}-2`;
    runGit(fixture.checkout, ["branch", releaseRef, fixture.targetSha]);
    runGit(fixture.checkout, ["tag", "-a", "v2026.8.1", fixture.targetSha, "-m", "base release"]);
    runGit(fixture.checkout, ["push", "origin", `refs/heads/${releaseRef}`, "refs/tags/v2026.8.1"]);
    expect(runGit(fixture.origin, ["tag", "--list", "v2026.8.1-2"])).toBe("");
    const result = fixture.run(["--target-ref", releaseRef]);
    expect(result.status, result.stderr).toBe(0);
    const creates = fixture
      .calls("POST")
      .filter((args) => ghApiEndpoint(args).endsWith("/git/refs"));
    expect(creates).toHaveLength(1);
    const branch = ghField(creates[0]!, "ref");
    expect(branch).toMatch(
      new RegExp(`^refs/heads/release-ci/${fixture.workflowSha.slice(0, 12)}-[0-9]+$`, "u"),
    );
    expect(ghField(creates[0]!, "sha")).toBe(fixture.workflowSha);
    const payload = fixture.readPayload();
    expect(payload.body.ref).toBe(branch.slice("refs/heads/".length));
    expect(payload.body.inputs).toMatchObject({
      ref: fixture.targetSha,
      expected_sha: fixture.targetSha,
      target_context_ref: releaseRef,
      allow_unreleased_changelog: "false",
    });
    expect(JSON.parse(payload.body.inputs.trusted_workflow_json ?? "{}").trustedWorkflow).toEqual({
      ref: "main",
      fullRef: "refs/heads/main",
      sha: fixture.workflowSha,
    });
    expect(fixture.gitCalls().filter((args) => args[0] === "push")).toEqual([]);
    expect(fixture.calls("DELETE").map(ghApiEndpoint)).toEqual([
      `repos/openclaw/openclaw/git/refs/${branch.slice("refs/".length)}`,
    ]);
    expect(runGit(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
      ["refs/heads/main", `refs/heads/${fixture.releaseRef}`, `refs/heads/${releaseRef}`].join(
        "\n",
      ),
    );
    expect(result.stdout).toContain("ok release evidence current=123 root=123");
  });

  it("retains uncertain workflow ref state when creation has an ambiguous failure", () => {
    const fixture = createDispatchFixture({ createRefFailure: true });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("configured workflow ref creation failure");
    expect(fixture.record().refs).toEqual({
      workflow: "uncertain",
    });
    const calls = fixture.calls();
    const createCalls = calls.filter((args) => args[0] === "api" && ghApiMethod(args) === "POST");
    const deleteCalls = calls.filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE");
    expect(createCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    expect(calls.some(isWorkflowDispatch)).toBe(false);
    expect(fixture.gitCalls().filter((args) => args[0] === "push")).toEqual([]);
    expect(fixture.refs()).toHaveLength(0);
  });

  it.each([true])(
    "rejects a failed bare-SHA preflight before retaining or mutating (dryRun=%s)",
    (dryRun) => {
      const fixture = createDispatchFixture({
        includeTargetRef: false,
        targetAlreadyRemote: false,
        bareShaFetchFailure: true,
      });
      const result = fixture.run(dryRun ? ["--dry-run"] : []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `GitHub refused to serve Validation SHA ${fixture.targetSha} by bare SHA; child checkouts fetch it the same way, so dispatch would fail.`,
      );
      expect(result.stderr).toContain("upload-pack: not our ref");
      expect(fixture.calls()).toEqual([]);
      const gitCalls = fixture.gitCalls();
      expect(gitCalls.filter((args) => args[0] === "push")).toEqual([]);
      const fetch = gitCalls.find((args) =>
        args.includes("https://github.com/openclaw/openclaw.git"),
      );
      expect(fetch).toBeDefined();
      expect(existsSync(fetch![1]!)).toBe(false);
      expect(existsSync(join(fixture.checkout, ".artifacts", "full-release-validation"))).toBe(
        false,
      );
    },
  );

  it("reports a workflow ref cleanup failure", () => {
    const fixture = createDispatchFixture({ deleteRefFailure: true });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to delete temporary ref");
    expect(result.stderr).toContain("configured workflow ref deletion failure");
    const deleteCalls = fixture
      .calls()
      .filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(ghApiEndpoint(deleteCalls[0] ?? [])).toContain("/git/refs/heads/release-ci/");
  });

  it("retries an absent decision artifact through a parent status regression", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress", artifactReady: true },
        { conclusion: null, status: "queued" },
        { conclusion: null, status: "in_progress" },
        { conclusion: "success", status: "completed" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    const parentPolls = calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => ghApiEndpoint(args).endsWith("/actions/runs/123"));
    const artifactDownloads = calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args[0] === "run" && args[1] === "download");
    expect(parentPolls).toHaveLength(6);
    expect(artifactDownloads).toHaveLength(4);
    expect(artifactDownloads[1]?.index).toBeGreaterThan(parentPolls[3]?.index ?? Infinity);
    expect(artifactDownloads[1]?.index).toBeLessThan(parentPolls[4]?.index ?? -Infinity);
    expect(result.stdout).toContain("Parent run status: queued/pending");
    expect(runGit(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
      "refs/heads/main\nrefs/heads/release/2026.8.1",
    );
  });

  it("waits for a terminal conclusion across every nonterminal parent state", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "requested" },
        { conclusion: null, status: "waiting" },
        { conclusion: null, status: "pending" },
        { conclusion: null, status: "completed" },
        { conclusion: "success", status: "completed" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/runs/123"))).toHaveLength(
      7,
    );
    expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(2);
  });

  it("observes a validated blocker promptly while leaving diagnostic drain and refs intact", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress" },
        {
          conclusion: null,
          status: "in_progress",
          artifactReady: true,
          decisionState: "blocked_diagnostics_running",
        },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("blocked_diagnostics_running");
    expect(fixture.readWaits()).toEqual([120_000]);
    const calls = fixture.calls();
    expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(1);
    expect(calls.some((args) => args.includes("cancel") || args.includes("watch"))).toBe(false);
    expect(fixture.refs()).toHaveLength(1);
  });

  it("does not redownload a validated decision or adopt a newer parent attempt", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress", artifactReady: true, decisionState: "passed" },
        { conclusion: null, status: "in_progress", artifactReady: true, decisionState: "passed" },
        { conclusion: null, status: "queued", attempt: 2 },
        { conclusion: null, status: "in_progress", attempt: 2, artifactReady: true },
        {
          conclusion: null,
          status: "queued",
          attempt: 2,
          decisionState: "blocked_diagnostics_running",
        },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "does not match the exact retained workflow/ref/event/attempt identity",
    );
    expect(fixture.readWaits()).toEqual([120_000, 120_000]);
    const downloads = fixture.calls().filter((args) => args[0] === "run" && args[1] === "download");
    expect(downloads.map((args) => args[args.indexOf("--name") + 1])).toEqual([
      "full-release-decision-123-1",
    ]);
    expect(fixture.record().run).toEqual({
      id: 123,
      attempt: 1,
    });
  });

  it("keeps progress reads sparse while checking unpublished decision metadata", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        ...Array.from({ length: 10 }, () => ({ conclusion: null, status: "in_progress" })),
        { conclusion: "success", status: "completed" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(1);
    expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/jobs"))).toHaveLength(1);
    expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/artifacts"))).toHaveLength(11);
    expect(fixture.readWaits()).toEqual(Array(10).fill(120_000));
  });

  it.each([
    { label: "wrong name", artifacts: [{ name: "full-release-decision-999-1", expired: false }] },
  ])("does not use $label metadata as a release decision", ({ artifacts }) => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        {
          conclusion: null,
          status: "in_progress",
          artifacts,
          decisionState: "blocked_diagnostics_running",
        },
        { conclusion: "failure", status: "completed", decisionState: "blocked_complete" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("blocked_complete");
    expect(fixture.readWaits()).toEqual([120_000]);
    const downloads = fixture.calls().filter((args) => args[0] === "run" && args[1] === "download");
    expect(downloads).toHaveLength(1);
  });

  it("rejects a downloaded decision from another attempt despite ready metadata", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        {
          conclusion: null,
          status: "in_progress",
          artifactReady: true,
          decisionState: "passed",
          decisionAttempt: 2,
        },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("binding is invalid");
    expect(fixture.readWaits()).toEqual([]);
    expect(fixture.refs()).toHaveLength(1);
  });

  it("dispatches non-main tooling only when its exact protected tag is supplied", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run([
      "--trusted-workflow-ref",
      fixture.trustedWorkflowTag,
      "--workflow-sha",
      fixture.workflowSha,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Trusted workflow ref: ${fixture.trustedWorkflowTag}`);
    expect(fixture.gitCalls()).toContainEqual([
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${fixture.trustedWorkflowTag}`,
    ]);
    const trustedIdentity = fixture.readPayload().body.inputs.trusted_workflow_json;
    expect(JSON.parse(trustedIdentity ?? "{}").trustedWorkflow).toEqual({
      ref: fixture.trustedWorkflowTag,
      fullRef: `refs/tags/${fixture.trustedWorkflowTag}`,
      sha: fixture.workflowSha,
    });
  });

  it("rejects a fresh request on pre-source contract 1 tooling without upgrading its frozen SHA", () => {
    const fixture = createDispatchFixture({ workflowSource: CONTRACT_ONE_WORKFLOW_SOURCE });
    const result = fixture.run([
      "--trusted-workflow-ref",
      fixture.trustedWorkflowTag,
      "--workflow-sha",
      fixture.workflowSha,
    ]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("does not support source admission");
    expect(fixture.calls().filter((args) => ghApiMethod(args) !== "GET")).toEqual([]);
  });

  it.each(["publish", "diagnostic"])(
    "requires registry capability only for fresh publish requests: %s",
    (purpose) => {
      const fixture = createDispatchFixture({
        candidateOwned: purpose === "publish",
        workflowSource: CURRENT_WORKFLOW_SOURCE.replace(
          '  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n',
          "",
        ),
      });
      const result = fixture.run([
        "--workflow-sha",
        purpose === "publish" ? fixture.targetSha : fixture.workflowSha,
        ...(purpose === "publish" ? [] : ["--trusted-workflow-ref", fixture.trustedWorkflowTag]),
        "-f",
        `validation_purpose=${purpose}`,
        ...(purpose === "publish"
          ? [
              "-f",
              `publication_selection_json=${JSON.stringify({
                route: "normal",
                npmDistTag: "beta",
                publishOpenclawNpm: true,
                pluginPublishScope: "all-publishable",
                plugins: [],
              })}`,
            ]
          : []),
      ]);
      expect(result.status, result.stderr).toBe(purpose === "publish" ? 1 : 0);
      if (purpose === "publish") {
        expect(result.stderr).toContain("does not support registry admission");
        expect(fixture.calls().filter((args) => ghApiMethod(args) !== "GET")).toEqual([]);
        expect(fixture.gitCalls().filter((args) => args[0] === "push")).toEqual([]);
        expect(existsSync(join(fixture.checkout, ".artifacts/full-release-validation"))).toBe(
          false,
        );
      }
    },
  );

  it("fails clearly before dispatch when the target SHA is absent after the named fetch", () => {
    const fixture = createDispatchFixture();
    const missingSha = "f".repeat(40);
    const result = fixture.run(["--sha", missingSha]);
    expect(result.status).toBe(1);
    const failedReasons = result.stderr
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("[full-release-validation] FAILED:"));
    expect(failedReasons).toEqual([
      `[full-release-validation] FAILED: Target SHA ${missingSha} is not available locally after fetching ${fixture.releaseRef}`,
    ]);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[full-release-validation] FAILED (exit 1)",
    );
    expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
  });

  it("supports current and legacy verifier locations in trusted workflow checkouts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-verifier-path-"));
    try {
      const legacy = join(
        root,
        ".agents",
        "skills",
        "release-openclaw-ci",
        "scripts",
        "release-ci-summary.mjs",
      );
      mkdirSync(join(legacy, ".."), { recursive: true });
      writeFileSync(legacy, "");
      expect(releaseEvidenceVerifierPath(root)).toBe(legacy);

      const current = join(root, "scripts", "release-ci-summary.mjs");
      mkdirSync(join(current, ".."), { recursive: true });
      writeFileSync(current, "");
      expect(releaseEvidenceVerifierPath(root)).toBe(current);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
