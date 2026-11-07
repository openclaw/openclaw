import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { buildReleaseExecutionPlan } from "../../scripts/full-release-validation-policy.mjs";
import { buildReleaseValidationManifest } from "../../scripts/lib/full-release-manifest.mjs";
import { RELEASE_VALIDATION_WAIVERS } from "../../scripts/lib/release-validation-waivers.mjs";
import { QUALIFICATION_WORKFLOW } from "../../scripts/release-qualification-admission.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { repository } from "./release-qualification-admission.test-support.js";
import { qualificationExemptionFixture } from "./release-qualification-exemption.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const original = structuredClone(RELEASE_VALIDATION_WAIVERS);
afterEach(() =>
  RELEASE_VALIDATION_WAIVERS.splice(
    0,
    RELEASE_VALIDATION_WAIVERS.length,
    ...structuredClone(original),
  ),
);

it("admits explicit not-run performance for the new target without reusing old measurements", () => {
  const data = qualificationExemptionFixture();
  const admission = data.produce();
  expect(admission.coverage.children.map((child) => child.key)).not.toContain("productPerformance");
  expect(admission.coverage.children.map((child) => child.key)).toEqual([
    "normalCi",
    "pluginPrereleaseIndependent",
    "pluginPrereleaseCandidate",
    "releaseChecksIndependent",
    "releaseChecksCandidate",
  ]);
  expect(admission.coverage.exemptions).toEqual([
    expect.objectContaining({
      targetVersion: "2026.9.37",
      disposition: "waived-not-run",
      supportingEvidence: expect.objectContaining({ targetSha: data.evidence.targetSha }),
    }),
  ]);
  expect(data.verify(admission)).toEqual(admission);
  expect(admission.request.candidateSha).not.toBe(data.evidence.targetSha);
  const children = buildReleaseExecutionPlan({
    parentRunId: "60",
    parentRunAttempt: 1,
    rerunGroup: "all",
    qualificationCoverage: admission.coverage,
  }).children;
  expect(children).toHaveLength(5);
  expect(children.every((child) => child.required && child.selected)).toBe(true);
  const root = candidatePublicationFixture();
  const manifest = buildReleaseValidationManifest({
    reusedManifest: undefined,
    plan: { ...root.plan, qualificationCoverage: admission.coverage },
    drain: undefined,
    context: {
      runId: root.runId,
      runAttempt: "1",
      releaseProfile: "stable",
      workflowRef: root.branch,
      workflowSha: root.q,
      targetRef: root.q,
      validationInputs: {},
    },
  });
  expect(manifest.childRuns.productPerformance).toEqual({
    disposition: "waived-not-run",
    runId: "",
    supportingEvidence: data.evidence,
  });
  expect(manifest.childEvidence.productPerformance).toBeUndefined();
  const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
  expect(workflow.jobs.resolve_target.outputs.performance_exempt).toBe(
    "${{ steps.tooling_identity.outputs.performance_exempt }}",
  );
  expect(workflow.jobs.performance.if).toContain(
    "needs.resolve_target.outputs.performance_exempt != 'true'",
  );
});

it.each([
  "mixed failure",
  "cancelled",
  "missing job",
  "bad upload",
  "wrong source",
  "wrong attempt",
  "tampered archive",
  "missing artifact",
  "unsupported Q",
  "revoked policy",
  "wrong version",
])("rejects %s rather than silently skipping performance", (fault) => {
  const data = qualificationExemptionFixture();
  if (fault === "mixed failure") {
    data.jobs[0]!.conclusion = "failure";
  }
  if (fault === "cancelled") {
    data.run.conclusion = "cancelled";
  }
  if (fault === "missing job") {
    data.jobs.splice(0, 1);
  }
  if (fault === "bad upload") {
    data.jobs.at(-1)!.steps.at(-1)!.conclusion = "failure";
  }
  if (fault === "wrong source") {
    data.run.head_sha = "c".repeat(40);
  }
  if (fault === "wrong attempt") {
    data.run.run_attempt = 2;
  }
  if (fault === "tampered archive") {
    data.evidence.artifactDigest = "sha256:" + "0".repeat(64);
  }
  if (fault === "missing artifact") {
    delete data.routes["actions/artifacts/" + data.evidence.artifactId];
  }
  if (fault === "unsupported Q") {
    data.f.sources.set(
      data.f.selected.candidateSha + ":" + QUALIFICATION_WORKFLOW,
      `on:
  workflow_dispatch:
    inputs:
` +
        Object.keys(data.f.selected.inputs)
          .map(
            (key) =>
              "      " +
              key +
              `:
        type: string
`,
          )
          .join(""),
    );
  }
  if (fault === "wrong version") {
    data.f.selected.inputs.trusted_workflow_json = data.baselines("2026.9.37");
    data.f.sources.set(
      data.f.selected.candidateSha + ":package.json",
      JSON.stringify({ version: "2026.9.38" }),
    );
    expect(data.produce().coverage.exemptions).toBeUndefined();
    return;
  }
  if (fault === "revoked policy") {
    const admission = data.produce();
    delete RELEASE_VALIDATION_WAIVERS.find((row) => row.targetVersion === "2026.9.37")!
      .qualificationExemption;
    expect(() => data.verify(admission)).toThrow(/current release-tooling policy/);
    return;
  }
  expect(() => data.produce()).toThrow();
});

it("emits the no-CPU workflow output only after real CLI admission authentication", () => {
  const data = qualificationExemptionFixture();
  const admission = data.produce();
  data.verify(admission);
  const root = tempDirs.make("qualification-cli-");
  const preload = join(root, "transport.mjs");
  const output = join(root, "output");
  const descriptor = {
    ...data.f.descriptor,
    artifactDigest: data.f.metadata.digest,
    artifactSizeBytes: data.f.metadata.size_in_bytes,
  };
  const args = [
    "--import",
    preload,
    "scripts/release-tooling-identity.mjs",
    "resolve",
    "--qualification-admission-json",
    JSON.stringify(descriptor),
    "--qualification-inputs-json",
    JSON.stringify(data.f.selected.inputs),
    "--candidate-sha",
    data.f.selected.candidateSha,
    "--repository",
    repository,
    "--workflow-contract",
    "2",
    "--workflow-ref",
    data.f.selected.transportRef,
    "--workflow-full-ref",
    "refs/heads/" + data.f.selected.transportRef,
    "--workflow-sha",
    data.f.selected.qualificationSha,
    "--requested-identity-json",
    JSON.stringify({
      ref: data.f.selected.transportRef,
      fullRef: "refs/heads/" + data.f.selected.transportRef,
      sha: data.f.selected.qualificationSha,
    }),
  ];
  const run = (destination: string) => {
    writeFileSync(
      preload,
      'import cp from "node:child_process"; import {syncBuiltinESMExports} from "node:module";\n' +
        "const responses = " +
        JSON.stringify(Object.fromEntries(data.responses)) +
        ";\n" +
        "const {RELEASE_VALIDATION_WAIVERS} = await import(" +
        JSON.stringify(
          pathToFileURL(join(process.cwd(), "scripts/lib/release-validation-waivers.mjs")).href,
        ) +
        "); RELEASE_VALIDATION_WAIVERS.splice(0, RELEASE_VALIDATION_WAIVERS.length, ..." +
        JSON.stringify(RELEASE_VALIDATION_WAIVERS) +
        ");\n" +
        'cp.execFileSync = (command,args,options) => { if(command !== "gh") throw Error("unexpected command"); const path=args.find(arg=>arg.startsWith("repos/")); if(!Object.hasOwn(responses,path)) throw Error("unrecorded transport: "+path); const bytes=Buffer.from(responses[path],"base64"); return options.encoding ? bytes.toString(options.encoding) : bytes; }; syncBuiltinESMExports();\n',
    );
    return spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "synthetic-test-token", GITHUB_OUTPUT: destination },
    });
  };
  const success = run(output);
  expect(success.stderr).toBe("");
  expect(success.status).toBe(0);
  expect(readFileSync(output, "utf8")).toBe("performance_exempt=true\n");
  data.responses.set(
    "repos/" + repository + "/actions/artifacts/" + data.evidence.artifactId + "/zip",
    Buffer.from("corrupted").toString("base64"),
  );
  const refusedOutput = join(root, "refused-output");
  const refused = run(refusedOutput);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("archive digest mismatch");
  expect(existsSync(refusedOutput)).toBe(false);
});
