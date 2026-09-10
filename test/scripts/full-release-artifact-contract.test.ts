import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { tryReadReleaseDecision } from "../../scripts/full-release-validation-at-sha.mts";
import {
  buildReleaseStateArtifact,
  composeReleaseAttemptJobs,
  MAX_RELEASE_ARTIFACT_BYTES,
  serializeReleaseArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { tryReadReleaseDecisionArtifact } from "../../scripts/release-ci-summary.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SHA = "a".repeat(40);

function fullMatrixChildren() {
  // Observed full-profile fanout from parent 33230733150, including both phases.
  const counts = {
    normalCi: 186,
    pluginPrereleaseIndependent: 38,
    pluginPrereleaseCandidate: 44,
    releaseChecksIndependent: 130,
    releaseChecksCandidate: 121,
    productPerformance: 7,
  };
  return Object.entries(counts).map(([key, count], childIndex) => {
    const runId = String(1000 + childIndex);
    const composite = composeReleaseAttemptJobs(
      [
        {
          runAttempt: 1,
          jobs: Array.from({ length: count }, (_, index) => ({
            name: `${key} / Docker and repository validation shard ${index}`,
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-29T03:25:00Z",
            completed_at: "2026-08-29T03:26:00Z",
            html_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}/job/${index + 1}`,
          })),
        },
      ],
      { plannedRunAttempt: 1, effectiveRunAttempt: 1 },
    );
    return {
      key,
      runId,
      selected: true,
      runAttempt: 1,
      plannedRunAttempt: 1,
      compositeJobsSha256: composite.sha256,
      jobs: composite.jobs,
      observedRunAttempts: [1],
      status: "completed",
      conclusion: "success",
      dispatchActor: "github-actions[bot]",
      triggeringActor: "github-actions[bot]",
      displayTitle: key,
      repository: "openclaw/openclaw",
      errors: [],
      workflow: `${key}.yml`,
      workflowRef: "main",
      workflowSha: SHA,
      url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
      createdAt: "2026-08-29T03:25:00Z",
      updatedAt: "2026-08-29T03:26:00Z",
    };
  });
}

function fullMatrixDecision(children = fullMatrixChildren()) {
  return buildReleaseStateArtifact({
    children,
    decision: { activeRunIds: [], blockers: [], errors: [], state: "passed" },
    executionPlan: { parentRunAttempt: 1, sha256: "b".repeat(64) },
    expected: {
      parentRunAttempt: 1,
      parentRunId: "123",
      workflowRef: "main",
      workflowSha: SHA,
      targetSha: SHA,
    },
    mode: "decision",
    releaseProfile: "full",
    rerunGroup: "all",
  });
}

describe("full release artifact contract", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function runDispatchWitness(event: unknown, rawEvent?: string) {
    const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
    const steps = workflow.jobs.resolve_target.steps;
    const writer = steps.find((step: { id?: string }) => step.id === "dispatch_witness");
    const dir = tempDirs.make("full-release-dispatch-inputs-");
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, rawEvent ?? JSON.stringify(event));
    const context = {
      serverUrl: "https://github.com",
      repository: "openclaw/openclaw",
      workflowRef:
        "openclaw/openclaw/.github/workflows/full-release-validation.yml@refs/heads/release-ci/test",
      event: "workflow_dispatch",
      ref: "refs/heads/release-ci/test",
      sha: SHA,
      runId: "123",
      runAttempt: "2",
    };
    const result = spawnSync("bash", ["-c", writer.run], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: dir,
        GITHUB_EVENT_PATH: eventPath,
        DISPATCH_SERVER_URL: context.serverUrl,
        DISPATCH_WORKFLOW_REF: context.workflowRef,
        GITHUB_REPOSITORY: context.repository,
        GITHUB_EVENT_NAME: context.event,
        GITHUB_REF: context.ref,
        GITHUB_SHA: context.sha,
        GITHUB_RUN_ID: context.runId,
        GITHUB_RUN_ATTEMPT: context.runAttempt,
      },
    });
    const artifactPath = join(dir, "full-release-dispatch-inputs/dispatch-inputs.json");
    const bytes = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "";
    return { result, bytes, context, dir, workflow, writer, steps };
  }

  it.each([false, true])("writes only a full-input digest and safe context (soak=%s)", (soak) => {
    const privateValue = "/private/example/operator/candidate.tgz";
    const secretValue = "synthetic-private-dispatch-value";
    const shellValue = 'line one\n$(touch unexpected) "quoted"';
    const { result, bytes, context, dir, workflow, writer, steps } = runDispatchWitness({
      inputs: {
        text: shellValue,
        secret: secretValue,
        package: privateValue,
        run_release_soak: String(soak),
        count: 3,
        empty: "",
      },
    });
    const canonical = JSON.stringify({
      count: "3",
      empty: "",
      package: privateValue,
      run_release_soak: String(soak),
      secret: secretValue,
      text: shellValue,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(bytes)).toEqual({
      kind: "openclaw.full-release-dispatch-inputs/v1",
      ...context,
      inputsDigest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    });
    for (const value of [privateValue, secretValue, shellValue]) {
      expect(bytes + result.stdout + result.stderr + JSON.stringify(writer.env)).not.toContain(
        value,
      );
    }
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(JSON.stringify(writer.env)).not.toMatch(/inputs|github\.event/u);
    expect(writer.run).not.toContain("${{");
    expect(existsSync(join(dir, "unexpected"))).toBe(false);
    expect(workflow.env.FULL_RELEASE_DISPATCH_WITNESS_CONTRACT).toBe("1");
    expect(steps.indexOf(writer)).toBeLessThan(
      steps.findIndex((step: { id?: string }) => step.id === "tooling_identity"),
    );
    expect(
      steps.find((step: { name?: string }) => step.name === "Upload root dispatch inputs").with,
    ).toMatchObject({
      name: "full-release-dispatch-inputs-${{ github.run_id }}-${{ github.run_attempt }}",
      "if-no-files-found": "error",
      "retention-days": 7,
    });
  });

  it("binds every declared input and default independently of event key order", () => {
    const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
    const definitions = workflow.on.workflow_dispatch.inputs as Record<
      string,
      { default?: unknown }
    >;
    const inputs = Object.fromEntries(
      Object.entries(definitions).map(([key, definition]) => {
        const value = definition.default ?? "";
        if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
          throw new Error("Workflow input default must be a primitive");
        }
        return [key, String(value)];
      }),
    );
    const original = runDispatchWitness({ inputs });
    expect(original.result.status, original.result.stderr).toBe(0);
    const reordered = runDispatchWitness({
      inputs: Object.fromEntries(Object.entries(inputs).toReversed()),
    });
    expect(reordered.result.status, reordered.result.stderr).toBe(0);
    expect(reordered.bytes).toBe(original.bytes);
    for (const key of Object.keys(inputs)) {
      const changed = runDispatchWitness({
        inputs: { ...inputs, [key]: `${inputs[key]}-changed` },
      });
      expect(changed.result.status, changed.result.stderr).toBe(0);
      expect(JSON.parse(changed.bytes).inputsDigest, key).not.toBe(
        JSON.parse(original.bytes).inputsDigest,
      );
    }
    expect(runDispatchWitness({ inputs: { value: false, count: 3 } }).bytes).toBe(
      runDispatchWitness({ inputs: { count: "3", value: "false" } }).bytes,
    );
    expect(runDispatchWitness({ inputs: { value: "" } }).bytes).not.toBe(
      runDispatchWitness({ inputs: {} }).bytes,
    );
  });

  it.each([
    {
      name: "oversized event",
      event: { inputs: {}, padding: "x".repeat(1024 * 1024) },
      error: "Invalid or oversized root dispatch event",
    },
    {
      name: "oversized inputs",
      event: { inputs: { payload: "x".repeat(129 * 1024) } },
      error: "Root dispatch inputs exceed their byte limit",
    },
    {
      name: "nested inputs",
      event: { inputs: { payload: { private: "synthetic-private-dispatch-value" } } },
      error: "Invalid root dispatch inputs",
    },
    {
      name: "malformed event",
      event: {},
      rawEvent: '{"inputs":"synthetic-private-dispatch-value',
      error: "Invalid or oversized root dispatch event",
    },
  ])(
    "refuses $name without a partial artifact or raw values in logs",
    ({ event, rawEvent, error }) => {
      const { result, bytes } = runDispatchWitness(event, rawEvent);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(result.stderr + result.stdout).not.toContain("synthetic-private-dispatch-value");
      expect(bytes).toBe("");
    },
  );

  it.each([false, true])(
    "writes all matrix evidence with reuse=%s without argv size limits",
    (reuse) => {
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
      const writer = workflow.jobs.summary.steps.find(
        (entry: { name: string }) => entry.name === "Write release validation manifest",
      );
      const children = fullMatrixChildren();
      const drain = fullMatrixDecision(children);
      const expectedChildren = Object.fromEntries(
        children.map((child) => [
          child.key,
          {
            runId: child.runId,
            plannedRunAttempt: child.plannedRunAttempt,
            effectiveRunAttempt: child.runAttempt,
            observedRunAttempts: child.observedRunAttempts,
            compositeJobsSha256: child.compositeJobsSha256,
            dispatchActor: child.dispatchActor,
            triggeringActor: child.triggeringActor,
            repository: child.repository,
            jobs: child.jobs.map(
              ({ name, status, conclusion, acceptedRunAttempt, startedAt, completedAt, url }) => ({
                name,
                status,
                conclusion,
                acceptedRunAttempt,
                startedAt,
                completedAt,
                url,
              }),
            ),
          },
        ]),
      );
      expect(Buffer.byteLength(JSON.stringify(expectedChildren))).toBeGreaterThan(128 * 1024);
      const sourceManifest = {
        releaseProfile: "stable",
        runReleaseSoak: "true",
        childRuns: { normalCi: "1000" },
        validationInputs: { provider: "openai" },
        controls: { stableSoakRequired: true },
        childEvidence: expectedChildren,
      };
      const plan = {
        targetSha: SHA,
        sha256: "b".repeat(64),
        parentRunAttempt: 1,
        candidate: { package: { sourceSha: SHA } },
        children: children.map((child) => ({
          key: child.key,
          runId: child.runId,
        })),
        evidenceReuse: {
          requested: reuse,
          selectedRunId: "99",
          rootRunId: "98",
          evidenceSha: "c".repeat(40),
          policy: "changelog-only-release-v1",
          changedPaths: ["CHANGELOG.md"],
          sourceManifest,
        },
      };
      const dir = tempDirs.make("full-release-manifest-");
      const planPath = join(dir, "plan.json");
      const drainPath = join(dir, "drain.json");
      writeFileSync(planPath, JSON.stringify(plan));
      writeFileSync(drainPath, serializeReleaseArtifact(drain));
      const result = spawnSync("bash", ["-c", writer.run], {
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.keys(writer.env).map((key) => [key, ""])),
          PATH: process.env.PATH,
          RUNNER_TEMP: dir,
          GITHUB_RUN_ID: "124",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_REF_NAME: "release-ci/test",
          GITHUB_SHA: "d".repeat(40),
          GITHUB_REF: "refs/heads/release-ci/test",
          GITHUB_REF_TYPE: "branch",
          TARGET_REF: SHA,
          RELEASE_PROFILE: "full",
          RERUN_GROUP: "all",
          RUN_RELEASE_SOAK: "true",
          RELEASE_EXECUTION_PLAN_PATH: planPath,
          DIAGNOSTIC_DRAIN_PATH: drainPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const bytes = readFileSync(
        join(dir, "full-release-validation/full-release-validation-manifest.json"),
        "utf8",
      );
      expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
      const manifest = JSON.parse(bytes);
      expect(manifest.childEvidence).toEqual(expectedChildren);
      expect(manifest).toMatchObject({
        version: 4,
        runId: "124",
        runAttempt: "2",
        targetSha: SHA,
        candidateBinding: plan.candidate,
        executionPlanSha256: plan.sha256,
        sourceParentRunAttempt: 1,
      });
      if (reuse) {
        expect(manifest).toMatchObject({
          releaseProfile: "stable",
          runReleaseSoak: "true",
          childRuns: sourceManifest.childRuns,
          validationInputs: sourceManifest.validationInputs,
          evidenceReuse: {
            policy: plan.evidenceReuse.policy,
            runId: "98",
            selectedRunId: "99",
            evidenceSha: plan.evidenceReuse.evidenceSha,
            changedPaths: ["CHANGELOG.md"],
          },
        });
      } else {
        expect(manifest).toMatchObject({
          releaseProfile: "full",
          rerunGroup: "all",
          childRuns: sourceManifest.childRuns,
        });
        expect(manifest).not.toHaveProperty("evidenceReuse");
      }
    },
  );

  it("compacts the full matrix without dropping job evidence and bounds UTF-8 bytes", () => {
    const payload = fullMatrixDecision();
    const compact = serializeReleaseArtifact(payload);
    expect(JSON.parse(compact)).toEqual(payload);
    expect(Buffer.byteLength(compact)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(compact)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
    expect(compact.split("\n")).toHaveLength(2);

    const value = "x".repeat(
      MAX_RELEASE_ARTIFACT_BYTES - Buffer.byteLength(serializeReleaseArtifact({ value: "" })),
    );
    expect(Buffer.byteLength(serializeReleaseArtifact({ value }))).toBe(MAX_RELEASE_ARTIFACT_BYTES);
    expect(() => serializeReleaseArtifact({ value: `${value}é` })).toThrow("size limit");
  });

  it.each(["ci.yml", "plugin-prerelease.yml"])(
    "keeps skipped matrix job names distinct in %s without renaming expanded checks",
    (file) => {
      const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
      const shards = Object.entries(workflow.jobs).filter(([, raw]) =>
        String((raw as { name?: string }).name).includes("matrix.check_name"),
      );
      expect(shards.length).toBeGreaterThan(1);
      for (const [id, raw] of shards) {
        expect((raw as { name: string }).name).toBe(`\${{ matrix.check_name || '${id}' }}`);
      }
    },
  );

  it.each(["dispatch helper", "summary watcher"])(
    "%s reads every job in the full release matrix",
    (reader) => {
      const payload = fullMatrixDecision();
      const serialized = JSON.stringify(payload, null, 2);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
      const download = (args: string[]) => {
        writeFileSync(
          join(args[args.indexOf("--dir") + 1]!, "full-release-decision.json"),
          serialized,
        );
      };
      const result =
        reader === "dispatch helper"
          ? tryReadReleaseDecision("123", 1, SHA, (_command, args) => {
              download(args);
              return { error: undefined, signal: null, status: 0, stderr: "", stdout: "" };
            })
          : tryReadReleaseDecisionArtifact(
              { attempt: 1, headSha: SHA },
              "123",
              "openclaw/openclaw",
              (args) => {
                download(args);
                return "";
              },
            );
      expect(result).toEqual(payload);
    },
  );

  it.each(["dispatch helper", "summary watcher"])(
    "%s rejects oversized evidence before parsing it",
    (reader) => {
      const download = (args: string[]) => {
        writeFileSync(
          join(args[args.indexOf("--dir") + 1]!, "full-release-decision.json"),
          " ".repeat(MAX_RELEASE_ARTIFACT_BYTES + 1),
        );
      };
      expect(() =>
        reader === "dispatch helper"
          ? tryReadReleaseDecision("123", 1, SHA, (_command, args) => {
              download(args);
              return { error: undefined, signal: null, status: 0, stderr: "", stdout: "" };
            })
          : tryReadReleaseDecisionArtifact(
              { attempt: 1, headSha: SHA },
              "123",
              "openclaw/openclaw",
              (args) => {
                download(args);
                return "";
              },
            ),
      ).toThrow("size limit");
    },
  );
});
