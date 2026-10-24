import { readFileSync, writeFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { semanticQualificationInputs } from "../../scripts/release-qualification-admission.mjs";
import {
  createDispatchFixture,
  ghApiEndpoint,
  ghApiMethod,
  isWorkflowDispatch,
  runGit,
  expectDispatchFailure,
} from "./full-release-validation-at-sha.test-support.js";
import { publicationSelectionFixture } from "./full-release-validation-state.test-support.js";

const P = "repos/openclaw/openclaw/actions/workflows/openclaw-release-prepare.yml/dispatches";
const Q = "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/dispatches";
const frozenBaselines = {
  upgradeBaseline: "openclaw@2026.7.9",
  upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@2026.7.8", "openclaw@2026.7.9"],
};
const npmVersionsArgs = ["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"];

type DispatchFixture = ReturnType<typeof createDispatchFixture>;
function dispatches(fixture: DispatchFixture) {
  return fixture.readCalls(fixture.ghCallsPath).filter(isWorkflowDispatch).map(ghApiEndpoint);
}
function expectNoWrites(fixture: DispatchFixture) {
  expect(
    fixture.readCalls(fixture.ghCallsPath).filter((args) => ghApiMethod(args) !== "GET"),
  ).toEqual([]);
}
function expectReadOnly(fixture: DispatchFixture, before: Buffer, callsBefore: number) {
  expect(readFileSync(fixture.requestPath())).toEqual(before);
  expect(
    fixture
      .readCalls(fixture.ghCallsPath)
      .slice(callsBefore)
      .filter((args) => ghApiMethod(args) !== "GET"),
  ).toEqual([]);
}

describe("candidate-owned full release dispatch entry point", () => {
  it.each(["main", "protected"])("rejects fresh %s publication before remote mutation", (route) => {
    const f = createDispatchFixture();
    const result = f.run([
      "--workflow-sha",
      f.workflowSha,
      "--trusted-workflow-ref",
      route === "main" ? "main" : f.trustedWorkflowTag,
      "-f",
      "validation_purpose=publish",
      "-f",
      `publication_selection_json=${JSON.stringify(publicationSelectionFixture())}`,
    ]);
    expectDispatchFailure(result, "Fresh publication qualification must use candidate-owned Q=C");
    expect(dispatches(f)).toEqual([]);
    expectNoWrites(f);
  });

  it("does not admit excluded candidate tests even when the lane input is explicit", () => {
    const f = createDispatchFixture({ candidateOwned: true });
    const result = f.run([
      "-f",
      'extension_test_exclude_patterns_json=["extensions/example/src/example.test.ts"]',
    ]);
    expectDispatchFailure(result, "Qualification admission did not succeed");
    expect(readFileSync(f.admissionReceiptPath + ".failure", "utf8")).toContain(
      "cannot exclude extension tests",
    );
    expect(dispatches(f)).toEqual([P]);
  });

  it("refuses main that keeps moving past the admission advance bound", () => {
    const f = createDispatchFixture({ candidateOwned: true, advanceMainBeforeAdmission: 4 });
    const result = f.run();
    expectDispatchFailure(result, "Admission tooling ref moved before dispatch");
    expect(dispatches(f)).toEqual([]);
  });

  it("keeps C=Q frozen through bounded main advances and delayed witness discovery", () => {
    const f = createDispatchFixture({
      candidateOwned: true,
      advanceMainBeforeAdmission: 3,
      advanceMainAfterAdmission: true,
      dispatchReturnsRunUrl: false,
      parentRunStates: [
        ...Array.from({ length: 6 }, () => ({ conclusion: null, status: "queued" })),
        { conclusion: "success", status: "completed" },
      ],
      witnessMissingReads: 6,
    });
    expect(f.targetSha).not.toBe(f.workflowSha);
    expect(() =>
      runGit(f.checkout, ["merge-base", "--is-ancestor", f.targetSha, "origin/main"]),
    ).toThrow();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(dispatches(f)).toEqual([P, Q]);
    const retained = f.record();
    const advancedP = runGit(f.origin, ["rev-parse", "refs/heads/main^"]);
    expect(advancedP).not.toBe(f.workflowSha);
    expect(result.stdout.match(/Admission P advanced with main/gu)).toHaveLength(3);
    expect(result.stderr).toContain("dispatch=pending-witness: run 123 (queued)");
    expect(f.readWaits()).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
    expect(retained).toMatchObject({ phase: "observed", run: { id: 123, attempt: 1 } });
    const admitted = JSON.parse(readFileSync(f.admissionReceiptPath, "utf8"));
    const sent = f.readPayload().body;
    const envelope = JSON.parse(
      expectDefined(sent.inputs.trusted_workflow_json, "dispatched envelope"),
    );
    expect(sent.ref).toBe(retained.request.workflowRef);
    expect(retained.request).toMatchObject({ workflowSha: f.targetSha, targetSha: f.targetSha });
    expect(retained.admission.workflowSha).toBe(advancedP);
    expect(envelope.trustedWorkflow).toEqual({
      ref: sent.ref,
      fullRef: "refs/heads/" + sent.ref,
      sha: f.targetSha,
    });
    expect(envelope.qualificationAdmission).toMatchObject({
      runId: 321,
      runAttempt: 1,
      workflowSha: advancedP,
      workflowFullRef: "refs/heads/main",
      artifactId: 9002,
    });
    expect(admitted.request.inputs).toEqual(semanticQualificationInputs(sent.inputs));
    expect(JSON.parse(envelope.laneInputs.qualification_baselines_json)).toEqual(frozenBaselines);
    expect(admitted.baselinePolicy).toMatchObject({
      candidateVersion: "2026.8.1",
      oldestSupportedBaseline: "2026.6.34",
    });
    expect(f.readCalls(f.npmCallsPath)).toEqual([npmVersionsArgs]);
    expect(admitted.coverage.profile).toBe("stable");
    expect(admitted.request).toMatchObject({
      candidateSha: f.targetSha,
      qualificationSha: f.targetSha,
      transportRef: sent.ref,
      reviewed: true,
    });
    expect(runGit(f.origin, ["rev-parse", "refs/heads/main"])).not.toBe(f.workflowSha);
    expect(() =>
      runGit(f.origin, ["merge-base", "--is-ancestor", f.targetSha, "refs/heads/main"]),
    ).toThrow();
  });

  it("reconciles an accepted uncertain admission response without another POST", () => {
    const f = createDispatchFixture({
      candidateOwned: true,
      admissionAcceptedFailure: true,
    });
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(dispatches(f)).toEqual([P, Q]);
    const before = readFileSync(f.requestPath(), "utf8");
    const reopened = f.run(["--reconcile-request", f.requestPath()], true);
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(dispatches(f)).toEqual([P, Q]);
    expect(readFileSync(f.requestPath(), "utf8")).toBe(before);
  });

  it("resumes the retained pre-Q request after a crash following accepted P", () => {
    const f = createDispatchFixture({ candidateOwned: true, stopAfterAccepted: "admission" });
    expect(f.run().status).toBe(78);
    expect(dispatches(f)).toEqual([P]);
    const pending = f.record();
    expect(f.readCalls(f.npmCallsPath)).toEqual([npmVersionsArgs]);
    writeFileSync(f.publishedVersionsPath, JSON.stringify(["2027.1.1"]));
    expect(pending).toMatchObject({
      phase: "prepared",
      refs: { workflow: "intended" },
      admission: { phase: "attempted" },
    });
    const before = readFileSync(f.requestPath(), "utf8");
    const reconcile = f.run(["--reconcile-request", f.requestPath()], true);
    expect(reconcile.status, reconcile.stderr).toBe(0);
    expect(reconcile.stdout).toContain("Qualification has not dispatched");
    expect(readFileSync(f.requestPath(), "utf8")).toBe(before);
    expect(dispatches(f)).toEqual([P]);
    const resumed = f.run(["--resume-request", f.requestPath()], true);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(dispatches(f)).toEqual([P, Q]);
    expect(f.record().request.id).toBe(pending.request.id);
    expect(f.record().request.workflowRef).toBe(pending.request.workflowRef);
    expect(
      JSON.parse(
        JSON.parse(f.record().request.inputs.trusted_workflow_json).laneInputs
          .qualification_baselines_json,
      ),
    ).toEqual(frozenBaselines);
    expect(f.readCalls(f.npmCallsPath)).toEqual([npmVersionsArgs]);
    const again = f.run(["--resume-request", f.requestPath()], true);
    expect(again.status, again.stderr).toBe(0);
    expect(dispatches(f)).toEqual([P, Q]);
  });

  it("does not reinterpret an accepted uncertain Q as resumable pre-Q work", () => {
    const f = createDispatchFixture({ candidateOwned: true, stopAfterAccepted: "qualification" });
    expect(f.run().status).toBe(78);
    expect(f.record().phase).toBe("attempted");
    expect(dispatches(f)).toEqual([P, Q]);
    const before = readFileSync(f.requestPath(), "utf8");
    const resumed = f.run(["--resume-request", f.requestPath()], true);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("dispatch=observed");
    expect(dispatches(f)).toEqual([P, Q]);
    expect(readFileSync(f.requestPath(), "utf8")).toBe(before);
  });

  it.each([
    {
      name: "moved P transport",
      options: { admissionMovedRef: true },
      expected: [],
      error: "Admission tooling ref moved before dispatch",
    },
    {
      name: "wrong P run SHA",
      options: { admissionWrongRunSha: true },
      expected: [P],
      error: "Admission workflow identity changed",
    },
    {
      name: "revoked operator",
      options: { admissionRevokedActor: true },
      expected: [P],
      error: "Qualification operator no longer has repository qualification authority",
    },
    {
      name: "failed exact upload",
      options: { admissionFailedUpload: true },
      expected: [P],
      error: "Actions artifact producer step did not complete successfully",
    },
    {
      name: "moved Q transport",
      options: { qualificationMovedRef: true },
      expected: [P],
      error: "Candidate qualification transport ref moved before dispatch",
    },
  ])(
    "refuses $name without substituting tooling or dispatching Q",
    ({ options, expected, error }) => {
      const f = createDispatchFixture({ candidateOwned: true, ...options });
      const result = f.run();
      expectDispatchFailure(result, error);
      expect(result.stderr).not.toContain("unexpected gh call");
      expect(dispatches(f)).toEqual(expected);
      expect(f.record().request).toMatchObject({
        workflowSha: f.targetSha,
        targetSha: f.targetSha,
      });
    },
  );
  it("retains publication and lane inputs in the envelope and reopens the same request read-only", () => {
    const fixture = createDispatchFixture({ candidateOwned: true });
    const excludedJson = JSON.stringify([], null, 1);
    const selected = {
      ...publicationSelectionFixture(),
      publishOpenclawNpm: false,
      pluginPublishScope: "selected",
      plugins: ["@openclaw/z", "@openclaw/a", "@openclaw/z"],
    };
    const selection = JSON.stringify(selected, null, 1);
    const result = fixture.run([
      "--workflow-sha",
      fixture.targetSha,
      "-f",
      "validation_purpose=publish",
      "-f",
      `publication_selection_json=${selection}`,
      "-f",
      `extension_test_exclude_patterns_json=${excludedJson}`,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(readFileSync(fixture.requestPath(), "utf8"));
    const wire = record.request.wireInputs.trusted_workflow_json;
    expect(JSON.parse(wire)).toEqual({
      trustedWorkflow: {
        ref: record.request.workflowRef,
        fullRef: "refs/heads/" + record.request.workflowRef,
        sha: fixture.targetSha,
      },
      qualificationAdmission: record.admission.descriptor,
      validationPurpose: "publish",
      publicationSelection: { ...selected, plugins: ["@openclaw/a", "@openclaw/z"] },
      laneInputs: {
        extension_test_exclude_patterns_json: "[]",
        qualification_baselines_json: JSON.stringify(frozenBaselines),
      },
    });
    expect(record.request.inputs.trusted_workflow_json).toBe(wire);
    expect(fixture.readPayload().body.inputs.trusted_workflow_json).toBe(wire);
    const before = readFileSync(fixture.requestPath());
    const callsBefore = fixture.readCalls(fixture.ghCallsPath).length;
    const reopened = fixture.run(
      [
        "--request-file",
        fixture.requestPath(),
        "-f",
        "validation_purpose=publish",
        "-f",
        `publication_selection_json=${JSON.stringify(JSON.parse(selection))}`,
        "-f",
        `extension_test_exclude_patterns_json=${excludedJson}`,
      ],
      true,
    );
    expect(reopened.status, reopened.stderr).toBe(0);
    expectReadOnly(fixture, before, callsBefore);
    const changedExclusion = fixture.run(
      [
        "--request-file",
        fixture.requestPath(),
        "-f",
        'extension_test_exclude_patterns_json=["extensions/example/src/example.test.ts"]',
      ],
      true,
    );
    expectDispatchFailure(changedExclusion, "conflict with the retained request");
    expectReadOnly(fixture, before, callsBefore);
    const mismatch = fixture.run(
      ["--request-file", fixture.requestPath(), "-f", "validation_purpose=diagnostic"],
      true,
    );
    expectDispatchFailure(mismatch, "conflict with the retained request");
    expectReadOnly(fixture, before, callsBefore);
  });

  it.each(["unreachable contribution", "internal thanks"])(
    "refuses publish qualification for %s before remote mutation",
    (reason) => {
      const unreachable = reason === "unreachable contribution";
      const fixture = createDispatchFixture({
        candidateOwned: true,
        ...(unreachable
          ? { unreachableContributionRecord: true }
          : { releaseNotes: "- Fixes: keep replies threaded. Thanks @steipete." }),
      });
      try {
        const result = fixture.run([
          "--workflow-sha",
          fixture.targetSha,
          "-f",
          "validation_purpose=publish",
          "-f",
          `publication_selection_json=${JSON.stringify({
            ...publicationSelectionFixture(),
            npmDistTag: unreachable ? "beta" : "latest",
          })}`,
        ]);
        expectDispatchFailure(
          result,
          unreachable
            ? `Candidate ${fixture.targetSha} would fail the pnpm release:candidate changelog gates for v2026.8.1`
            : "Forbidden changelog thanks attribution (pnpm check:changelog-attributions): CHANGELOG.md:3 uses Thanks @steipete. Use verified human GitHub credits",
        );
        if (unreachable) {
          expect(result.stderr).toMatch(
            new RegExp(
              `contribution record target [0-9a-f]{40} is not reachable from release tag ${fixture.targetSha}`,
              "u",
            ),
          );
        }
        expectNoWrites(fixture);
      } finally {
        fixture.cleanup();
      }
    },
  );
});
