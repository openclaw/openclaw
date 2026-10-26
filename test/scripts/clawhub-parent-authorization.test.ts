import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  clawHubIdentityFromEnvironment,
  createClawHubParentAuthorization,
  createClawHubRecoveryApproval,
  resolvePackedClawHubArtifactDir,
  validateClawHubIdentity,
  validateClawHubParentAuthorization,
  validateClawHubTransactions,
  validateClawHubWorkflowRun,
} from "../../scripts/clawhub-parent-authorization.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const ref = `release-publish/${sha.slice(0, 12)}-1`;
const recoveryEnv = {
  GITHUB_REPOSITORY: "openclaw/openclaw",
  GITHUB_RUN_ID: "30",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTOR: "octocat",
  RELEASE_PUBLISH_RUN_ID: "10",
  RELEASE_PUBLISH_RUN_ATTEMPT: "2",
  RECOVERED_CLAWHUB_RUN_ID: "20",
  RECOVERED_CLAWHUB_RUN_ATTEMPT: "1",
};
const noGh = () => {
  throw new Error("unexpected GitHub lookup");
};
const workflowPath = ".github/workflows/plugin-clawhub-release.yml";
type WorkflowStep = Partial<Record<"id" | "name" | "uses" | "run" | "if", string>> & {
  env?: Record<string, string>;
  with?: Record<string, string>;
};
function workflow() {
  return parse(readFileSync(workflowPath, "utf8")) as {
    jobs: Record<
      | "approve_plugins_clawhub_release"
      | "validate_release_publish_approval"
      | "seal_clawhub_transactions"
      | "publish_plugins_clawhub",
      {
        environment?: string;
        if?: string;
        permissions?: Record<string, string>;
        steps: WorkflowStep[];
        with?: Record<string, string>;
      }
    >;
  };
}
function rejectRecovery(patch: Record<string, string>, error: RegExp) {
  expect(() => createClawHubRecoveryApproval({ ...recoveryEnv, ...patch }, noGh)).toThrow(error);
}
function parentArtifacts(names: string[], total = names.length) {
  return (path: string) => {
    expect(path).toMatch(/^actions\/runs\/10\/artifacts\?per_page=100&page=[1-9]/u);
    const page = Number(/page=(\d+)$/u.exec(path)?.[1]);
    return {
      total_count: total,
      artifacts: names.slice((page - 1) * 100, page * 100).map((name) => ({ name })),
    };
  };
}
function transactions(count = 1) {
  return {
    schemaVersion: 1,
    identity: {
      version: 2,
      repository: "openclaw/openclaw",
      workflow: ".github/workflows/plugin-clawhub-release.yml",
      runId: "20",
      runAttempt: "1",
      ref,
      fullRef: `refs/tags/${ref}`,
      sha,
      candidateRepository: "openclaw/openclaw",
      candidateSha: "b".repeat(40),
      toolingRef: "main",
      toolingFullRef: "refs/heads/main",
      toolingSha: sha,
      parentRepository: "openclaw/openclaw",
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      parentRunId: "10",
      parentRunAttempt: "1",
    },
    packages: Array.from({ length: count }, (_, index) => ({
      name: `@openclaw/plugin-${String(index).padStart(3, "0")}`,
      version: "2026.8.2",
      inventoryDigest: "c".repeat(64),
      artifactName: `clawhub-package-${index}`,
      artifactSha256: "d".repeat(64),
      artifactSize: 100,
    })),
  };
}
function authorization(route = "automated-awaited", count = 1) {
  const sealed = transactions(count);
  const receipt = createClawHubParentAuthorization(sealed, route);
  const validate = (patch = {}) =>
    validateClawHubParentAuthorization({ ...receipt, ...patch }, sealed);
  return { sealed, receipt, validate };
}

it("rejects alpha package transactions before granting parent authority", () => {
  const value = transactions();
  value.packages[0]!.version = "2026.8.2-alpha.1";
  expect(() => validateClawHubTransactions(value)).not.toThrow();
  expect(() => createClawHubParentAuthorization(value, "automated-awaited")).toThrow(
    "Alpha releases are retired;",
  );
});

describe("ClawHub parent publication authorization", () => {
  it("does not fall back to the flat directory when a matrix artifact is missing", () => {
    const directory = tempDirs.make("clawhub-packed-");
    expect(
      resolvePackedClawHubArtifactDir({ directory, artifactName: "missing", matrixSize: 2 }),
    ).toBe(join(directory, "missing"));
  });
  it("writes an exact human recovery receipt once for the child and parent attempts", () => {
    const receipt = createClawHubRecoveryApproval(recoveryEnv, noGh);
    expect(receipt).toStrictEqual({
      version: 2,
      kind: "openclaw-clawhub-recovery-approval",
      repository: "openclaw/openclaw",
      workflow: ".github/workflows/plugin-clawhub-release.yml",
      runId: "30",
      runAttempt: "1",
      actor: "octocat",
      environment: "clawhub-plugin-release",
      approvalJob: "approve_plugins_clawhub_release",
      authorizationRoute: "explicit-recovery",
      parentRunId: "10",
      parentRunAttempt: "2",
      authorizedChildRunId: "20",
      authorizedChildRunAttempt: "1",
    });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(8 * 1024);
    for (const actor of ["github-actions[bot]", "Something[Bot]", ""]) {
      rejectRecovery({ GITHUB_ACTOR: actor }, /human login/u);
    }
    for (const key of [
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "RELEASE_PUBLISH_RUN_ID",
      "RELEASE_PUBLISH_RUN_ATTEMPT",
    ]) {
      for (const value of ["invalid", "0", "01", ""]) {
        rejectRecovery({ [key]: value }, /invalid/u);
      }
    }
    // Explicit recovered-child inputs are validated as a pair; one half never falls back to discovery.
    for (const key of ["RECOVERED_CLAWHUB_RUN_ID", "RECOVERED_CLAWHUB_RUN_ATTEMPT"]) {
      for (const value of ["invalid", "0", "01", " ", "", "1.5"]) {
        rejectRecovery({ [key]: value }, /Recovered ClawHub run (id|attempt) is invalid/u);
      }
    }
    rejectRecovery({ GITHUB_REPOSITORY: "other/repository" }, /repository/u);
    rejectRecovery({ GITHUB_RUN_ID: "1".repeat(8 * 1024) }, /8 KiB/u);

    const directory = tempDirs.make("clawhub-recovery-approval-");
    const output = join(directory, "approval.json");
    const args = [
      "scripts/clawhub-parent-authorization.mjs",
      "recovery-approval",
      "--output",
      output,
    ];
    const options = { env: { ...process.env, ...recoveryEnv }, encoding: "utf8" } as const;
    const first = spawnSync(process.execPath, args, options);
    expect(first.status, first.stderr).toBe(0);
    const contents = readFileSync(output, "utf8");
    expect(JSON.parse(contents)).toEqual(receipt);
    expect(contents).toBe(`${JSON.stringify(receipt)}\n`);
    const second = spawnSync(process.execPath, args, options);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("EEXIST");
  });

  it("discovers the authorized child from the parent attempt's single v2 receipt", () => {
    const env = { ...recoveryEnv, RECOVERED_CLAWHUB_RUN_ID: "", RECOVERED_CLAWHUB_RUN_ATTEMPT: "" };
    const discover = (names: string[], total = names.length) =>
      createClawHubRecoveryApproval(env, parentArtifacts(names, total));
    const receiptName = "openclaw-clawhub-parent-authorization-v2-10-2-21-3";
    const unrelated = [
      "openclaw-release-children-10-2",
      "openclaw-clawhub-parent-authorization-v2-10-1-20-1",
      "openclaw-clawhub-parent-authorization-v2-11-2-22-1",
      "openclaw-clawhub-transactions-21-3",
    ];
    expect(discover([...unrelated, receiptName])).toMatchObject({
      authorizedChildRunId: "21",
      authorizedChildRunAttempt: "3",
      parentRunId: "10",
      parentRunAttempt: "2",
    });
    // Receipts land on later pages of a full release inventory.
    const padded = Array.from({ length: 150 }, (_, index) => `clawhub-package-${index}`);
    expect(discover([...padded, receiptName])).toMatchObject({
      authorizedChildRunId: "21",
      authorizedChildRunAttempt: "3",
    });
    expect(() => discover(unrelated)).toThrow(
      /has no openclaw-clawhub-parent-authorization-v2-10-2-\* receipt; pass recovered_clawhub_run_id and recovered_clawhub_run_attempt/u,
    );
    const rival = "openclaw-clawhub-parent-authorization-v2-10-2-25-1";
    expect(() => discover([receiptName, rival])).toThrow(
      new RegExp(`ambiguous receipts \\(${receiptName}, ${rival}\\)`, "u"),
    );
    expect(() => discover(["openclaw-clawhub-parent-authorization-v2-10-2-021-3"])).toThrow(
      /Malformed parent authorization receipt name/u,
    );
    expect(() => discover([receiptName], 2)).toThrow(
      /Incomplete release parent artifact inventory/u,
    );
    // Explicit inputs win without any parent lookup.
    expect(createClawHubRecoveryApproval(recoveryEnv, noGh)).toMatchObject({
      authorizedChildRunId: "20",
      authorizedChildRunAttempt: "1",
    });
  });

  it("uploads recovery approval only for direct human dispatches from trusted tooling", () => {
    const config = workflow();
    const approval = config.jobs.approve_plugins_clawhub_release;
    const directRecovery =
      "needs.validate_release_publish_approval.outputs.direct_recovery == 'true'";
    const receiptRoute =
      "needs.validate_release_publish_approval.outputs.parent_approval == 'receipt'";
    const checkout = approval.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toMatchObject({
      if: `${directRecovery} || ${receiptRoute}`,
      with: { ref: "${{ github.workflow_sha }}" },
    });
    const write = approval.steps.find((step) => step.run?.includes("recovery-approval --output"));
    expect(write?.if).toBe(directRecovery);
    // Discovery lists the parent run's receipts, so the job needs a token and actions:read.
    expect(approval.permissions).toEqual({ actions: "read", contents: "read" });
    expect(write?.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
      RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      RECOVERED_CLAWHUB_RUN_ID: "${{ inputs.recovered_clawhub_run_id }}",
      RECOVERED_CLAWHUB_RUN_ATTEMPT: "${{ inputs.recovered_clawhub_run_attempt }}",
    });
    const upload = approval.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe(directRecovery);
    const artifactName =
      "openclaw-clawhub-recovery-approval-${{ github.run_id }}-${{ github.run_attempt }}";
    expect(upload?.with).toMatchObject({
      name: artifactName,
      "if-no-files-found": "error",
    });
    expect(write?.run).toContain(upload?.with?.path?.replace("${{ runner.temp }}", "$RUNNER_TEMP"));
  });

  it("publishes source metadata for the exact candidate sealed into authorization", () => {
    const config = workflow();
    const candidate = config.jobs.seal_clawhub_transactions?.steps?.find(
      (step) => step.env?.TARGET_SHA,
    )?.env?.TARGET_SHA;
    expect(candidate).toBe("${{ needs.preview_plugins_clawhub.outputs.ref_revision }}");
    // ClawHub compares both source fields with the candidate SHA in the publish token.
    expect(config.jobs.publish_plugins_clawhub?.with).toMatchObject({
      source_commit: candidate,
      source_ref: candidate,
    });
  });

  it("binds the full release roster beyond 8 KiB without mixing parent and child refs", () => {
    const { sealed, receipt, validate } = authorization("automated-awaited", 89);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeGreaterThan(8192);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(65536);
    expect(receipt.fullRef).toBe("refs/heads/main");
    expect(receipt.childFullRef).toBe(`refs/tags/${ref}`);
    expect(receipt.packages).toEqual(
      sealed.packages.map(({ name, version, inventoryDigest }) => ({
        name,
        version,
        inventoryDigest,
      })),
    );
    expect(validate()).toEqual(receipt);
  });

  it.each(["childRunId", "childRunAttempt", "candidateSha", "toolingSha", "childFullRef"])(
    "rejects receipt substitution of %s",
    (key) => {
      const { validate } = authorization("automated-detached");
      expect(() => validate({ [key]: "changed" })).toThrow(/mismatch/u);
    },
  );

  it("rejects package selection and inventory substitutions", () => {
    const { sealed, receipt, validate } = authorization();
    for (const patch of [
      { name: "@openclaw/other" },
      { version: "2026.8.3" },
      { inventoryDigest: "e".repeat(64) },
    ]) {
      expect(() => validate({ packages: [{ ...receipt.packages[0], ...patch }] })).toThrow(
        /mismatch/u,
      );
    }
    expect(() =>
      validateClawHubTransactions({
        ...sealed,
        packages: [...sealed.packages, ...sealed.packages],
      }),
    ).toThrow(/Duplicate/u);
    expect(() => createClawHubParentAuthorization(sealed, "explicit-recovery")).toThrow(/route/u);
  });

  it("rejects branch/tag aliases and different executing tooling", () => {
    const { identity } = transactions();
    expect(() => validateClawHubIdentity({ ...identity, fullRef: `refs/heads/${ref}` })).toThrow(
      /protected/u,
    );
    expect(() => validateClawHubIdentity({ ...identity, sha: "e".repeat(40) })).toThrow();
    expect(() => validateClawHubIdentity({ ...identity, extra: true })).toThrow(/fields/u);
  });

  it("records the executing child context rather than candidate source as producer", () => {
    const { identity } = transactions();
    const env = {
      GITHUB_REPOSITORY: identity.repository,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: identity.runAttempt,
      GITHUB_REF_NAME: identity.ref,
      GITHUB_REF: identity.fullRef,
      GITHUB_WORKFLOW_SHA: identity.sha,
      TARGET_SHA: identity.candidateSha,
      RELEASE_PUBLISH_BRANCH: identity.toolingRef,
      RELEASE_PUBLISH_FULL_REF: identity.toolingFullRef,
      RELEASE_PUBLISH_WORKFLOW_SHA: identity.toolingSha,
      RELEASE_PUBLISH_RUN_ID: identity.parentRunId,
      RELEASE_PUBLISH_RUN_ATTEMPT: identity.parentRunAttempt,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflow}@${identity.fullRef}`,
    };
    expect(clawHubIdentityFromEnvironment(env)).toEqual(identity);
    expect(() =>
      clawHubIdentityFromEnvironment({
        ...env,
        GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflow}@refs/heads/main`,
      }),
    ).toThrow(/context/u);
  });

  it("rejects replaced attempts, cancelled runs, and contradictory qualified refs", () => {
    const { identity } = transactions();
    const run = {
      id: 20,
      run_attempt: 1,
      repository: { full_name: identity.repository },
      head_repository: { full_name: identity.repository },
      event: "workflow_dispatch",
      path: identity.workflow,
      head_sha: sha,
      head_branch: ref,
      status: "completed",
      conclusion: "success",
    };
    expect(validateClawHubWorkflowRun(run, identity, { terminal: true })).toEqual(run);
    for (const patch of [
      { run_attempt: 2 },
      { conclusion: "cancelled" },
      { path: `${identity.workflow}@refs/heads/${ref}` },
      { head_sha: "b".repeat(40) },
    ]) {
      expect(() => validateClawHubWorkflowRun({ ...run, ...patch }, identity)).toThrow();
    }
    expect(() =>
      validateClawHubWorkflowRun({ ...run, status: "in_progress", conclusion: null }, identity, {
        terminal: true,
      }),
    ).toThrow(/state/u);
  });
});
