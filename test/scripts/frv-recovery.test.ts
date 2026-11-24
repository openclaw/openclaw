import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseChildSpec } from "../../scripts/full-release-validation-policy.mjs";
import { releaseChildReuseSha256 } from "../../scripts/lib/full-release-child-request.mjs";
import {
  dispatchReceiptRecovery,
  discoverReceiptRecoveryRequest,
  parseReceiptRecoveryArgs,
  reconcileReceiptRecovery,
} from "../../scripts/lib/full-release-recovery-dispatch.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { recoveryConsumptionFixture } from "./release-evidence-consumption.test-support.js";

const P = "c".repeat(40);
const Q = "a".repeat(40);
const repository = "openclaw/openclaw";
const roles = [
  "normalCi",
  "pluginPrereleaseIndependent",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
  "pluginPrereleaseCandidate",
];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(candidateSha = Q) {
  const directory = mkdtempSync(join(tmpdir(), "recovery-operator-"));
  directories.push(directory);
  const path = join(directory, "request.json");
  const identity = {
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    event: "workflow_dispatch",
    head_sha: Q,
    head_branch: "release-ci-qualification",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  };
  const parent = { ...identity, id: 10, path: ".github/workflows/full-release-validation.yml" };
  const runs = new Map<number, Record<string, unknown>>([[10, parent]]);
  const artifacts = new Map<string, Array<Record<string, unknown>>>();
  const archives = new Map<number, Buffer>();
  const jobs: Array<{ id: number; name: string; steps?: Array<Record<string, unknown>> }> = [];
  const logs = new Map<number, string>();
  function artifact(runId: number, name: string, file: string, value: unknown) {
    const bytes = makeStoredZip({ [file]: JSON.stringify(value) + "\n" });
    const id = archives.size + 100;
    archives.set(id, bytes);
    const metadata = {
      id,
      name,
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      size_in_bytes: bytes.length,
      expires_at: "2099-01-01T00:00:00Z",
      expired: false,
    };
    artifacts.set(String(runId), [...(artifacts.get(String(runId)) ?? []), metadata]);
    return metadata;
  }
  function dispatch(id: number, name: string, workflow: string) {
    jobs.push({ id, name });
    logs.set(
      id,
      "Dispatched " +
        workflow +
        ": https://github.com/" +
        repository +
        "/actions/runs/" +
        id +
        " (attempt 1)",
    );
    runs.set(id, { ...identity, id, path: ".github/workflows/" + workflow });
  }
  artifact(10, "full-release-source-admission-parent-10-1", "publication-source-admission.json", {
    candidateSha,
    qualificationAdmission: { runId: 9 },
  });
  const candidate = { request: { targetSha: candidateSha, toolingSha: Q } };
  for (const [index, stage] of ["npm", "candidate", "docker"].entries()) {
    const id = 20 + index;
    dispatch(id, stage, "full-release-artifacts.yml");
    const run = runs.get(id)!;
    run.display_title = "Full Release Artifacts full-release-validation-10-1-artifacts-" + stage;
    artifact(id, "full-release-artifact-receipt-" + id + "-1", "artifact-receipt.json", {
      schema: "openclaw.full-release-artifact-receipt/v1",
      stage,
      sourceSha: candidateSha,
      toolingSha: Q,
      workflowRef: identity.head_branch,
      repository,
      runId: String(id),
      runAttempt: "1",
      dispatchId: "full-release-validation-10-1-artifacts-" + stage,
      outputs: {
        binding_json: JSON.stringify(candidate),
        qualified_preflight_bundle_json: JSON.stringify({ original: "npm" }),
        prepared_run_id: "22",
        prepared_run_attempt: "1",
        prepared_artifact_name: "docker",
        prepared_manifest_sha256: "d".repeat(64),
      },
    });
  }
  dispatch(23, "Prepare exact plugin npm artifacts", "plugin-npm-release.yml");
  artifact(23, "plugin-npm-prepared-" + candidateSha + "-23-1", "plugin-npm-prepared.json", {
    producer: {
      repository,
      runId: 23,
      runAttempt: 1,
      workflowSha: Q,
      workflowPath: ".github/workflows/plugin-npm-release.yml",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: identity.head_branch,
    },
  });
  roles.forEach((role, index) => {
    const id = 30 + index;
    dispatch(id, role, releaseChildSpec(role).workflow);
    artifact(
      id,
      "full-release-child-evidence-" + candidateSha + "-" + role + "-" + id + "-1",
      "full-release-child-evidence.json",
      {
        targetSha: candidateSha,
        workflowSha: Q,
        workflowRef: identity.head_branch,
        displayTitle: "original " + role,
        sourceParentRunId: "10",
        sourceParentAttempt: 1,
        inputs: {},
        sha256: "b".repeat(64),
      },
    );
  });
  const client = {
    getRunAttempt: vi.fn(async () => parent),
    getRun: vi.fn(async (id: string) => runs.get(Number(id))),
    getRunArtifacts: vi.fn(async (id: string) => artifacts.get(id) ?? []),
    downloadArtifactArchive: vi.fn(async ({ expected }: { expected: { artifactId: number } }) => ({
      archiveBytes: archives.get(expected.artifactId),
    })),
    getRunAttemptJobs: vi.fn(async () => jobs),
    getJobLog: vi.fn(async (id: number) => logs.get(id)),
    verifyQualificationAdmission: vi.fn(
      async (
        _verification: Parameters<
          typeof import("../../scripts/release-qualification-admission.mjs").verifyQualificationAdmission
        >[0],
      ) => ({ coverage: { children: roles.map((key) => ({ key, parentJobName: key })) } }),
    ),
    getWorkflowSource: vi.fn((sha: string) =>
      sha === P
        ? 'env:\n  FULL_RELEASE_RECEIPT_RECOVERY_CONTRACT: "1"\n  FULL_RELEASE_RECEIPT_RECOVERY_REQUEST_CONTRACT: "1"\nrun-name: Receipt Recovery ' +
          "$" +
          "{{ fromJSON(inputs.request).requestId }}"
        : "jobs:\n  npm:\n    name: npm\n    env:\n      CHILD_WORKFLOW_KIND: artifact-npm\n  candidate:\n    name: candidate\n    env:\n      CHILD_WORKFLOW_KIND: artifact-candidate\n  docker:\n    name: docker\n    env:\n      CHILD_WORKFLOW_KIND: artifact-docker\n",
    ),
    getRef: vi.fn(async () => ({ object: { type: "commit", sha: P } })),
    listRecoveryRuns: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    postRecovery: vi.fn(async (_wire: string) => {}),
  };
  function observeRecovery(status = "in_progress", conclusion: string | null = null) {
    const request = JSON.parse(readFileSync(path, "utf8")).request;
    const run = {
      ...parent,
      id: 99,
      head_sha: P,
      head_branch: "main",
      path: ".github/workflows/full-release-receipt-recovery.yml",
      display_title: "Receipt Recovery " + request.requestId,
      status,
      conclusion,
    };
    runs.set(99, run);
    client.listRecoveryRuns.mockResolvedValue([run]);
    return { request, run };
  }
  return {
    path,
    artifact,
    client,
    observeRecovery,
    artifacts,
    jobs,
    runs,
    logs,
    options: { runId: "10", workflowSha: P, requestFile: path },
  };
}

describe("retained receipt recovery operator", () => {
  it.each([false, true])(
    "recovers missing parent source from authenticated inputs (changed=%s)",
    async (changed) => {
      const f = fixture();
      const original = candidatePublicationFixture({ candidateSha: Q, runId: "10" });
      f.artifacts.set("10", []);
      for (const child of original.admission.receipt.coverage.children) {
        f.jobs.find((job) => job.name === child.key)!.name = child.parentJobName;
      }
      f.runs.get(10)!.head_branch = original.branch;
      const frozen = f.client.getWorkflowSource(Q);
      f.client.getWorkflowSource.mockImplementation(
        () =>
          frozen +
          `
  resolve_target:
    name: Resolve target ref
    steps:
      - name: Resolve trusted workflow identity
        env:
          QUALIFICATION_ADMISSION_JSON: descriptor
          QUALIFICATION_INPUTS_JSON: inputs
`,
      );
      const step = {
        name: "Resolve trusted workflow identity",
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-19T09:00:00Z",
        completed_at: "2026-11-19T09:00:01Z",
      };
      f.jobs.push({ id: 50, name: "Resolve target ref", steps: [step] });
      const inputs = {
        ...original.admission.receipt.request.inputs,
        ...(changed ? { mode: "install" } : {}),
      };
      f.logs.set(
        50,
        `2026-11-19T09:00:00.1Z ##[group]Run trusted identity
2026-11-19T09:00:00.2Z env:
2026-11-19T09:00:00.3Z   QUALIFICATION_ADMISSION_JSON: ${JSON.stringify(original.admission.descriptor)}
2026-11-19T09:00:00.4Z   QUALIFICATION_INPUTS_JSON: ${JSON.stringify(inputs, null, 2)}
2026-11-19T09:00:00.5Z   CANDIDATE_SHA: ${Q}
2026-11-19T09:00:00.6Z ##[endgroup]`,
      );
      f.client.verifyQualificationAdmission.mockImplementation(async (verification) =>
        original.client.verifyQualificationAdmission(verification),
      );
      const result = discoverReceiptRecoveryRequest("10", P, f.client);
      if (changed) {
        await expect(result).rejects.toThrow("authenticated operator request");
      } else {
        await expect(result).resolves.toMatchObject({
          qualificationAdmission: original.admission.descriptor,
          candidateBinding: { request: { targetSha: Q, toolingSha: Q } },
        });
        expect(f.client.verifyQualificationAdmission).toHaveBeenCalledWith(
          expect.objectContaining({ inputs }),
        );
      }
    },
  );
  it("discovers a rerun parent without changing qualification attempt 1", async () => {
    const f = fixture();
    const parent = f.runs.get(10)!;
    f.runs.set(10, { ...parent, run_attempt: 2, conclusion: "failure" });
    const request = await discoverReceiptRecoveryRequest("10", P, f.client);
    expect(request.originalParent).toEqual({ runId: "10", runAttempt: 1, currentRunAttempt: 2 });
    expect(f.client.getRunAttempt).toHaveBeenCalledWith("10", 1);
  });

  it("discovers missing-plan descriptors, retains before auth and POST, and never retries an uncertain POST", async () => {
    const f = fixture("b".repeat(40));
    f.client.postRecovery.mockImplementation(async (wire) => {
      const record = JSON.parse(readFileSync(f.path, "utf8"));
      expect(record.phase).toBe("attempted");
      expect(f.client.verifyQualificationAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ candidateSha: "b".repeat(40), qualificationSha: Q }),
      );
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(JSON.parse(wire).inputs.request)).toEqual(record.request);
      expect(Object.keys(record.request.children)).toEqual(roles);
      expect(record.request.publicationArtifacts.npmPreflight).toEqual({ original: "npm" });
      throw new Error("connection lost after acceptance");
    });
    expect(await dispatchReceiptRecovery(f.options, f.client)).toMatchObject({
      action: "recovery-unconfirmed",
      phase: "attempted",
    });
    await dispatchReceiptRecovery(f.options, f.client);
    expect(f.client.postRecovery).toHaveBeenCalledTimes(1);
    f.observeRecovery();
    expect(await reconcileReceiptRecovery(f.path, f.client)).toMatchObject({
      action: "recovery-unconfirmed",
      requestAuthenticated: false,
      runId: "99",
      complete: false,
    });
    expect(f.client.postRecovery).toHaveBeenCalledTimes(1);
  });

  it("discovers and authenticates an adopted child without a plan, rejecting a changed adoption digest", async () => {
    const f = fixture();
    const full = recoveryConsumptionFixture(
      candidatePublicationFixture({ candidateSha: Q, runId: "777" }),
    );
    const role = "pluginPrereleaseIndependent";
    const selected = full.recovery.children[role]!;
    const expected = {
      ...selected,
      inputs: Object.fromEntries(
        Object.entries(selected.inputs).filter(
          ([key, value]) => key !== "dispatch_id" && value !== "",
        ),
      ),
    };
    const log =
      "TARGET_SHA: " +
      Q +
      "\nFRV_CHILD_REUSE_SHA256=" +
      releaseChildReuseSha256(expected) +
      "\nReused " +
      releaseChildSpec(role).workflow +
      ": " +
      expected.url +
      " (attempt 1)";
    f.logs.set(31, log);
    const client = {
      ...f.client,
      getRun: (id: string) =>
        id === selected.runId ? full.client.getRun(id) : f.client.getRun(id),
      getRunArtifacts: (id: string) =>
        id === selected.runId ? full.client.getRunArtifacts(id) : f.client.getRunArtifacts(id),
      downloadArtifactArchive: (options: { expected: { artifactId: number } }) =>
        String(options.expected.artifactId) === selected.artifact.id
          ? full.client.downloadArtifactArchive(options)
          : f.client.downloadArtifactArchive(options),
    };
    const discovered = await discoverReceiptRecoveryRequest("10", P, client);
    expect(discovered.children[role]).toEqual(expected);
    const authenticated = await full.client.validateChildReuse(discovered.children[role], {
      repository,
      targetSha: Q,
      workflowSha: Q,
      role,
      inputs: expected.inputs,
    });
    expect(authenticated.selection).toEqual(expected);
    f.logs.set(31, log.replace(releaseChildReuseSha256(expected), "0".repeat(64)));
    await expect(dispatchReceiptRecovery(f.options, client)).rejects.toThrow(
      "reuse adoption witness mismatch",
    );
    expect(f.client.postRecovery).not.toHaveBeenCalled();
  });

  it("rejects another request under the exact run title", async () => {
    const f = fixture();
    await dispatchReceiptRecovery(f.options, f.client);
    const { request } = f.observeRecovery();
    f.artifact(99, "full-release-recovery-request-99-1", "request.json", {
      ...request,
      originalParent: { runId: "11", runAttempt: 1 },
    });
    await expect(reconcileReceiptRecovery(f.path, f.client)).rejects.toThrow("witness differs");
    expect(f.client.postRecovery).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful aggregate carrying a different retained request", async () => {
    const f = fixture();
    await dispatchReceiptRecovery(f.options, f.client);
    const { request } = f.observeRecovery("completed", "success");
    const client = {
      ...f.client,
      loadManifest: () => ({
        artifact: {},
        manifest: {
          receiptRecovery: { ...request, originalParent: { runId: "11", runAttempt: 1 } },
        },
      }),
    };
    await expect(reconcileReceiptRecovery(f.path, client)).rejects.toThrow(
      "completed recovery request differs",
    );
    expect(f.client.postRecovery).toHaveBeenCalledTimes(1);
  });

  it("dispatches after bounded admission revalidation; full receipt verification belongs to the workflow", async () => {
    const f = fixture();
    await dispatchReceiptRecovery(f.options, f.client);
    expect(f.client.verifyQualificationAdmission).toHaveBeenCalledTimes(2);
    expect(f.client.postRecovery).toHaveBeenCalledTimes(1);
  });

  it("fails closed before POST on final authority rejection, retaining the original request", async () => {
    const f = fixture();
    f.client.verifyQualificationAdmission
      .mockImplementationOnce(async () => ({
        coverage: { children: roles.map((key) => ({ key, parentJobName: key })) },
      }))
      .mockRejectedValueOnce(new Error("admission authority revoked"));
    await expect(dispatchReceiptRecovery(f.options, f.client)).rejects.toThrow(
      "admission authority revoked",
    );
    expect(JSON.parse(readFileSync(f.path, "utf8")).phase).toBe("prepared");
    await dispatchReceiptRecovery(f.options, f.client);
    expect(f.client.postRecovery).not.toHaveBeenCalled();
  });

  it("does not send after P moves and rejects changed retained identity", async () => {
    const f = fixture();
    f.client.getRef.mockResolvedValue({ object: { type: "commit", sha: Q } });
    await expect(dispatchReceiptRecovery(f.options, f.client)).rejects.toThrow("main moved");
    expect(f.client.postRecovery).not.toHaveBeenCalled();
    await expect(
      dispatchReceiptRecovery({ ...f.options, workflowSha: Q }, f.client),
    ).rejects.toThrow("existing request differs");
  });

  it("rejects wrong-P or duplicate reconciliation matches without a POST", async () => {
    const f = fixture();
    await dispatchReceiptRecovery(f.options, f.client);
    const request = JSON.parse(readFileSync(f.path, "utf8")).request;
    const run = { ...f.runs.get(10), display_title: "Receipt Recovery " + request.requestId };
    f.client.listRecoveryRuns.mockResolvedValue([run]);
    await expect(reconcileReceiptRecovery(f.path, f.client)).rejects.toThrow(
      "observed recovery identity differs",
    );
    f.client.listRecoveryRuns.mockResolvedValue([run, run]);
    await expect(reconcileReceiptRecovery(f.path, f.client)).rejects.toThrow("ambiguous recovery");
    expect(f.client.postRecovery).toHaveBeenCalledTimes(1);
  });

  it("names missing original evidence rather than accepting manual descriptors", async () => {
    const f = fixture();
    f.artifacts.set("10", []);
    await expect(discoverReceiptRecoveryRequest("10", P, f.client)).rejects.toThrow(
      "frozen admission input step is missing or ambiguous",
    );
    expect(f.client.postRecovery).not.toHaveBeenCalled();
  });

  it("rejects retargeting reconciliation, unsupported tuples, and duplicate arguments", () => {
    expect(
      parseReceiptRecoveryArgs([
        "--run",
        "10",
        "--workflow-sha",
        P,
        "--request-file",
        "private.json",
      ]),
    ).toMatchObject({ workflowSha: P, runId: "10" });
    for (const args of [
      ["--reconcile-request", "x", "--run", "10"],
      ["--reconcile-request", "x", "--policy-sha", Q],
      ["--run", "10", "--workflow-sha", P, "--request-file", "x", "--policy-sha", Q],
      [
        "--run",
        "10",
        "--workflow-sha",
        P,
        "--prepare-policy-admission",
        "--policy-sha",
        Q,
        "--policy-admission-run",
        "8",
      ],
      ["--run", "10", "--run", "20"],
      ["--children", "{}"],
      [],
    ]) {
      expect(() => parseReceiptRecoveryArgs(args)).toThrow();
    }
  });
});
