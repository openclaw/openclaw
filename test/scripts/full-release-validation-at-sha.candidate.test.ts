import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { semanticQualificationInputs } from "../../scripts/release-qualification-admission.mjs";
import {
  createDispatchFixture,
  ghApiEndpoint,
  ghApiMethod,
  isWorkflowDispatch,
  runGit,
} from "./full-release-validation-at-sha.test-support.js";

const P = "repos/openclaw/openclaw/actions/workflows/openclaw-release-prepare.yml/dispatches";
const Q = "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/dispatches";
const frozenBaselines = {
  upgradeBaseline: "openclaw@2026.7.9",
  upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@2026.7.8", "openclaw@2026.7.9"],
};
const npmVersionsArgs = ["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"];

function dispatches(fixture: ReturnType<typeof createDispatchFixture>) {
  return fixture.readCalls(fixture.ghCallsPath).filter(isWorkflowDispatch).map(ghApiEndpoint);
}

function readRequestRecord(fixture: ReturnType<typeof createDispatchFixture>) {
  return JSON.parse(readFileSync(fixture.requestPath(), "utf8"));
}

describe("candidate-owned full release dispatch entry point", () => {
  it("refuses a candidate without its data-owned support floor before npm or dispatch", () => {
    const f = createDispatchFixture({
      candidateOwned: true,
      targetSource: {
        "scripts/lib/upgrade-survivor-scenarios.json": "{}",
      },
    });
    try {
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing its data-owned upgrade baseline policy");
      expect(f.readCalls(f.npmCallsPath)).toEqual([]);
      expect(dispatches(f)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("does not replace an unavailable predecessor with a future registry release", () => {
    const f = createDispatchFixture({ candidateOwned: true });
    try {
      writeFileSync(f.publishedVersionsPath, JSON.stringify(["2027.1.1"]));
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no published stable OpenClaw baseline predates candidate");
      expect(f.readCalls(f.npmCallsPath)).toEqual([npmVersionsArgs]);
      expect(dispatches(f)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  it.each(["main", "protected"])("rejects fresh %s publication before remote mutation", (route) => {
    const f = createDispatchFixture();
    try {
      const result = f.run([
        "--workflow-sha",
        f.workflowSha,
        "--trusted-workflow-ref",
        route === "main" ? "main" : f.trustedWorkflowTag,
        "-f",
        "validation_purpose=publish",
        "-f",
        `publication_selection_json=${JSON.stringify({
          route: "normal",
          npmDistTag: "latest",
          publishOpenclawNpm: true,
          pluginPublishScope: "all-publishable",
          plugins: [],
        })}`,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Fresh publication qualification must use candidate-owned Q=C",
      );
      expect(dispatches(f)).toEqual([]);
      expect(f.readCalls(f.ghCallsPath).filter((args) => ghApiMethod(args) !== "GET")).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("does not admit excluded candidate tests even when the lane input is explicit", () => {
    const f = createDispatchFixture({ candidateOwned: true });
    try {
      const result = f.run([
        "-f",
        'extension_test_exclude_patterns_json=["extensions/example/src/example.test.ts"]',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Qualification admission did not succeed");
      expect(readFileSync(f.admissionReceiptPath + ".failure", "utf8")).toContain(
        "cannot exclude extension tests",
      );
      expect(dispatches(f)).toEqual([P]);
    } finally {
      f.cleanup();
    }
  });
  it("advances main-selected P to a verified descendant before the admission POST", () => {
    const f = createDispatchFixture({ candidateOwned: true, advanceMainBeforeAdmission: 3 });
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(dispatches(f)).toEqual([P, Q]);
      const advancedP = runGit(f.origin, ["rev-parse", "refs/heads/main"]);
      expect(advancedP).not.toBe(f.workflowSha);
      expect(result.stdout.match(/Admission P advanced with main/gu)).toHaveLength(3);
      const retained = readRequestRecord(f);
      expect(retained.admission.workflowSha).toBe(advancedP);
      expect(retained.request.workflowSha).toBe(f.targetSha);
      const envelope = JSON.parse(
        expectDefined(f.readPayload().body.inputs.trusted_workflow_json, "dispatched envelope"),
      );
      expect(envelope.qualificationAdmission).toMatchObject({
        workflowSha: advancedP,
        workflowFullRef: "refs/heads/main",
      });
    } finally {
      f.cleanup();
    }
  });

  it("refuses main that keeps moving past the admission advance bound", () => {
    const f = createDispatchFixture({ candidateOwned: true, advanceMainBeforeAdmission: 4 });
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Admission tooling ref moved before dispatch");
      expect(dispatches(f)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("keeps divergent C=Q frozen while independent P admits and main advances", () => {
    const f = createDispatchFixture({ candidateOwned: true, advanceMainAfterAdmission: true });
    try {
      expect(f.targetSha).not.toBe(f.workflowSha);
      expect(() =>
        runGit(f.checkout, ["merge-base", "--is-ancestor", f.targetSha, "origin/main"]),
      ).toThrow();
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(dispatches(f)).toEqual([P, Q]);
      const retained = readRequestRecord(f);
      const admitted = JSON.parse(readFileSync(f.admissionReceiptPath, "utf8"));
      const sent = f.readPayload().body;
      const envelope = JSON.parse(
        expectDefined(sent.inputs.trusted_workflow_json, "dispatched envelope"),
      );
      expect(sent.ref).toBe(retained.request.workflowRef);
      expect(retained.request.workflowSha).toBe(f.targetSha);
      expect(retained.request.targetSha).toBe(f.targetSha);
      expect(retained.admission.workflowSha).toBe(f.workflowSha);
      expect(envelope.trustedWorkflow).toEqual({
        ref: sent.ref,
        fullRef: "refs/heads/" + sent.ref,
        sha: f.targetSha,
      });
      expect(envelope.qualificationAdmission).toMatchObject({
        runId: 321,
        runAttempt: 1,
        workflowSha: f.workflowSha,
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
      expect(result.stderr).not.toContain("packages/ai/package.json");
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
      const reads = f
        .readCalls(f.ghCallsPath)
        .filter((call) => ghApiMethod(call) === "GET")
        .map(ghApiEndpoint);
      expect(
        reads.some((endpoint) =>
          endpoint.includes(
            "/contents/.github/workflows/openclaw-release-prepare.yml?ref=" + f.workflowSha,
          ),
        ),
      ).toBe(true);
      expect(reads.some((endpoint) => endpoint.endsWith("/actions/artifacts/9002/zip"))).toBe(true);
      expect(reads.some((endpoint) => endpoint.includes("/actions/runs/321/attempts/1/jobs"))).toBe(
        true,
      );
      expect(reads.some((endpoint) => endpoint.includes("/compare/" + f.targetSha))).toBe(false);
      expect(readFileSync(f.pathGhCallsPath, "utf8")).toBe("");
      expect(readFileSync(f.fetchCallsPath, "utf8")).toBe("");
    } finally {
      f.cleanup();
    }
  });

  it("waits for the candidate witness without redispatch or baseline resolution", () => {
    const queued = { conclusion: null, status: "queued" };
    const f = createDispatchFixture({
      candidateOwned: true,
      dispatchReturnsRunUrl: false,
      parentRunStates: [
        ...Array.from({ length: 6 }, () => queued),
        { conclusion: "success", status: "completed" },
      ],
      witnessMissingReads: 6,
    });
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("dispatch=pending-witness: run 123 (queued)");
      expect(f.readWaits()).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
      expect(dispatches(f)).toEqual([P, Q]);
      expect(f.readCalls(f.npmCallsPath)).toEqual([npmVersionsArgs]);
      expect(readRequestRecord(f)).toMatchObject({
        phase: "observed",
        request: { targetSha: f.targetSha, workflowSha: f.targetSha },
        run: { id: 123, attempt: 1 },
      });
    } finally {
      f.cleanup();
    }
  });

  it.each(["admission", "qualification"] as const)(
    "reconciles an accepted uncertain %s response without another POST",
    (stage) => {
      const f = createDispatchFixture({
        candidateOwned: true,
        admissionAcceptedFailure: stage === "admission",
        acceptedDispatchFailure: stage === "qualification",
      });
      try {
        const result = f.run();
        expect(result.status, result.stderr).toBe(0);
        expect(dispatches(f)).toEqual([P, Q]);
        const before = readFileSync(f.requestPath(), "utf8");
        const reopened = f.run(["--reconcile-request", f.requestPath()], true);
        expect(reopened.status, reopened.stderr).toBe(0);
        expect(dispatches(f)).toEqual([P, Q]);
        expect(readFileSync(f.requestPath(), "utf8")).toBe(before);
      } finally {
        f.cleanup();
      }
    },
  );

  it("resumes the retained pre-Q request after a crash following accepted P", () => {
    const f = createDispatchFixture({ candidateOwned: true, stopAfterAccepted: "admission" });
    try {
      expect(f.run().status).toBe(78);
      expect(dispatches(f)).toEqual([P]);
      const pending = readRequestRecord(f);
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
      expect(readRequestRecord(f).request.id).toBe(pending.request.id);
      expect(readRequestRecord(f).request.workflowRef).toBe(pending.request.workflowRef);
      expect(
        JSON.parse(
          JSON.parse(readRequestRecord(f).request.inputs.trusted_workflow_json).laneInputs
            .qualification_baselines_json,
        ),
      ).toEqual(frozenBaselines);
      expect(f.readCalls(f.npmCallsPath)).toEqual([npmVersionsArgs]);
      const again = f.run(["--resume-request", f.requestPath()], true);
      expect(again.status, again.stderr).toBe(0);
      expect(dispatches(f)).toEqual([P, Q]);
    } finally {
      f.cleanup();
    }
  });

  it("does not reinterpret an accepted uncertain Q as resumable pre-Q work", () => {
    const f = createDispatchFixture({ candidateOwned: true, stopAfterAccepted: "qualification" });
    try {
      expect(f.run().status).toBe(78);
      expect(readRequestRecord(f).phase).toBe("attempted");
      expect(dispatches(f)).toEqual([P, Q]);
      const before = readFileSync(f.requestPath(), "utf8");
      const resumed = f.run(["--resume-request", f.requestPath()], true);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain("dispatch=observed");
      expect(dispatches(f)).toEqual([P, Q]);
      expect(readFileSync(f.requestPath(), "utf8")).toBe(before);
    } finally {
      f.cleanup();
    }
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
      try {
        const result = f.run();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(error);
        expect(result.stderr).not.toContain("unexpected gh call");
        expect(dispatches(f)).toEqual(expected);
        expect(readRequestRecord(f).request.workflowSha).toBe(f.targetSha);
        expect(readRequestRecord(f).request.targetSha).toBe(f.targetSha);
      } finally {
        f.cleanup();
      }
    },
  );
  it("retains publication and lane inputs in the envelope and reopens the same request read-only", () => {
    const fixture = createDispatchFixture({ candidateOwned: true });
    const excluded: string[] = [];
    const excludedJson = JSON.stringify(excluded, null, 1);
    const selection = JSON.stringify(
      {
        route: "normal",
        npmDistTag: "latest",
        publishOpenclawNpm: true,
        plugins: [],
        pluginPublishScope: "all-publishable",
      },
      null,
      1,
    );
    try {
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
        publicationSelection: JSON.parse(selection),
        laneInputs: {
          extension_test_exclude_patterns_json: JSON.stringify(excluded),
          qualification_baselines_json: JSON.stringify(frozenBaselines),
        },
      });
      expect(record.request.inputs.trusted_workflow_json).toBe(wire);
      expect(fixture.readPayload().body.inputs.trusted_workflow_json).toBe(wire);
      expect(record.request.inputs).not.toHaveProperty("validation_purpose");
      expect(record.request.wireInputs).not.toHaveProperty("publication_selection_json");
      expect(record.request.wireInputs).not.toHaveProperty("extension_test_exclude_patterns_json");
      expect(record.request.wireInputs).not.toHaveProperty("known_flaky_jobs_json");
      expect(Object.keys(fixture.readPayload().body.inputs)).toHaveLength(25);
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
      expect(readFileSync(fixture.requestPath())).toEqual(before);
      const changedExclusion = fixture.run(
        [
          "--request-file",
          fixture.requestPath(),
          "-f",
          'extension_test_exclude_patterns_json=["extensions/example/src/example.test.ts"]',
        ],
        true,
      );
      expect(changedExclusion.status).toBe(1);
      expect(changedExclusion.stderr).toContain("conflict with the retained request");
      expect(readFileSync(fixture.requestPath())).toEqual(before);
      expect(
        fixture
          .readCalls(fixture.ghCallsPath)
          .slice(callsBefore)
          .filter((args) => ghApiMethod(args) !== "GET"),
      ).toEqual([]);
      const mismatch = fixture.run(
        ["--request-file", fixture.requestPath(), "-f", "validation_purpose=diagnostic"],
        true,
      );
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain("conflict with the retained request");
      expect(readFileSync(fixture.requestPath())).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("reopens the original selected-plugin spelling after dispatch canonicalizes order and duplicates", () => {
    const fixture = createDispatchFixture({ candidateOwned: true });
    const original = JSON.stringify({
      route: "normal",
      npmDistTag: "latest",
      publishOpenclawNpm: false,
      pluginPublishScope: "selected",
      plugins: ["@openclaw/z", "@openclaw/a", "@openclaw/z"],
    });
    try {
      const request = [
        "--request-file",
        join(fixture.checkout, "request.json"),
        "-f",
        "validation_purpose=publish",
        "-f",
        `publication_selection_json=${original}`,
      ];
      const first = fixture.run(["--workflow-sha", fixture.targetSha, ...request]);
      expect(first.status, first.stderr).toBe(0);
      const path = join(fixture.checkout, "request.json");
      const before = readFileSync(path);
      const record = JSON.parse(before.toString());
      expect(
        JSON.parse(record.request.wireInputs.trusted_workflow_json).publicationSelection.plugins,
      ).toEqual(["@openclaw/a", "@openclaw/z"]);
      const callsBefore = fixture.readCalls(fixture.ghCallsPath).length;
      const reopened = fixture.run(request, true);
      expect(reopened.status, reopened.stderr).toBe(0);
      expect(readFileSync(path)).toEqual(before);
      expect(
        fixture
          .readCalls(fixture.ghCallsPath)
          .slice(callsBefore)
          .every((args) => ghApiMethod(args) === "GET"),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
