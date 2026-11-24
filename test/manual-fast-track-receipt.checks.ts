import { createHash } from "node:crypto";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { fastTrackRequestDigest } from "../scripts/lib/release-fast-track-contract.mts";
import {
  fastTrackAdmissionTime,
  releaseFastTrackDigest,
} from "../scripts/lib/release-fast-track-publication.mts";
import * as receiptModule from "../scripts/release-approval-receipt.mjs";
import {
  createReleaseApprovalReceipt,
  downloadReleaseApprovalReceipt,
  validateReleaseApprovalReceipt,
  verifyReleaseApprovalReceipt,
} from "../scripts/release-approval-receipt.mjs";
import * as toolingModule from "../scripts/release-tooling-identity.mjs";

const sha = "a".repeat(40);
const target = "b".repeat(40);
const releaseTag = "v2026.11.9-beta.1";
const workflow = ".github/workflows/openclaw-release-publish.yml";
const jobName = "Publish plugins, then OpenClaw";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const request = {
    schemaVersion: 1,
    policy: "approved-fast-track-v1",
    action: "Approve skipping release validation",
    repository: "openclaw/openclaw",
    releaseTag,
    channel: "beta",
    candidateSha: target,
    reference: {
      releaseTag: "v2026.11.8",
      targetSha: sha,
      validationEvidenceDigest: `sha256:${sha}000000000000000000000000`,
    },
    delta: { commits: 1, added: 1, deleted: 0 },
    artifacts: [{ name: "publication-artifacts", digest: `sha256:${"c".repeat(64)}` }],
    publicationScope: [`publication:sha256:${"d".repeat(64)}`],
    run: { id: "2", attempt: "1" },
    requestId: "00000000-0000-4000-8000-000000000001",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const packet = {
    request,
    digest: fastTrackRequestDigest(request),
    approval: {
      approver: "octocat",
      decidedAt: new Date(Date.now() - 60000).toISOString(),
      url: "https://chat.google.com/room/synthetic/message",
    },
    referenceRunId: "1",
    referenceRunAttempt: "1",
  };
  const env = {
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF_NAME: "main",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `openclaw/openclaw/${workflow}@refs/heads/main`,
    RELEASE_TAG: releaseTag,
    TARGET_SHA: target,
    RELEASE_NPM_DIST_TAG: "beta",
    FAST_TRACK_APPROVAL_JSON: JSON.stringify(packet),
  };
  const approvals = [
    { state: "approved", environments: [{ name: "npm-release" }], user: { login: "octocat" } },
  ];
  const receipt = createReleaseApprovalReceipt(env, () => approvals);
  const expected = {
    repository: "openclaw/openclaw",
    parentRunId: "10",
    parentRunAttempt: "2",
    toolingRef: "main",
    toolingFullRef: "refs/heads/main",
    toolingSha: sha,
    releaseTag,
    targetSha: target,
    npmDistTag: "beta",
    fastTrackApproval: packet,
  };
  const parentRun = {
    id: 10,
    run_attempt: 2,
    event: "workflow_dispatch",
    repository: { full_name: "openclaw/openclaw" },
    head_branch: "main",
    head_sha: sha,
    path: workflow,
    status: "in_progress",
    conclusion: null as string | null,
  };
  const parentJobs = {
    total_count: 1,
    jobs: [
      {
        name: jobName,
        head_sha: sha,
        run_id: 10,
        run_attempt: 2,
        status: "in_progress",
        started_at: new Date(Date.now()).toISOString(),
        steps: [
          { name: "Write release approval receipt", status: "completed", conclusion: "success" },
        ],
      },
    ],
  };
  const artifact = {
    id: 50,
    name: "openclaw-release-approval-v1-10-2",
    expired: false,
    workflow_run: { id: 10, head_sha: sha, repository_id: 99, head_repository_id: 99 },
  };
  return { packet, env, receipt, expected, parentRun, parentJobs, approvals, artifact };
}

it("checks fast-track expiry after the environment approval wait before issuing a new receipt", () => {
  vi.useFakeTimers();
  const f = fixture();
  const afterWait = () =>
    createReleaseApprovalReceipt(f.env, () => {
      vi.setSystemTime(Date.parse(f.packet.request.expiresAt) + 1);
      return f.approvals;
    });
  expect(afterWait).toThrow("expired before publication admission");
  expect(() => createReleaseApprovalReceipt(f.env, () => f.approvals)).toThrow(
    "expired before publication admission",
  );
  // Ordinary publication does not acquire a new fast-track requirement.
  expect(
    createReleaseApprovalReceipt({ ...f.env, FAST_TRACK_APPROVAL_JSON: "" }, () => f.approvals),
  ).toMatchObject({ version: 1 });
});

it("binds the whole fast-track packet to the existing receipt and rejects missing or altered packets", () => {
  const f = fixture();
  expect(f.receipt).toMatchObject({
    version: 4,
    fastTrackDigest: releaseFastTrackDigest(f.packet),
  });
  expect(verifyReleaseApprovalReceipt(f)).toBe(f.receipt);
  for (const fastTrackApproval of [
    undefined,
    { ...f.packet, approval: { ...f.packet.approval, url: "https://chat.google.com/changed" } },
  ]) {
    expect(() =>
      verifyReleaseApprovalReceipt({ ...f, expected: { ...f.expected, fastTrackApproval } }),
    ).toThrow("fast-track packet");
  }
  for (const receipt of [
    { ...f.receipt, extra: true },
    { ...f.receipt, version: 1 },
    { ...f.receipt, fastTrackDigest: undefined },
  ]) {
    expect(() => validateReleaseApprovalReceipt(receipt)).toThrow();
  }
  const retired = createReleaseApprovalReceipt(
    {
      ...f.env,
      RELEASE_TAG: "v2026.10.33",
      RELEASE_NPM_DIST_TAG: "extended-stable",
      RETIRED_LINE_PUBLICATION_REASON: "Explicit older-line publication",
    },
    () => f.approvals,
  );
  expect(retired).toMatchObject({
    version: 4,
    retiredLineReason: "Explicit older-line publication",
    fastTrackDigest: f.receipt.fastTrackDigest,
  });
  const deferred = createReleaseApprovalReceipt(
    {
      ...f.env,
      PUBLISH_OPENCLAW_NPM: "true",
      PLUGIN_PUBLISH_SCOPE: "all-publishable",
      PREPARED_NPM_ARTIFACT: "synthetic",
      PREPARED_PUBLICATION_INPUT: JSON.stringify({
        corePluginDeferrals: [
          {
            packageName: "@openclaw/demo",
            version: releaseTag.slice(1),
            sourceSha: target,
            reason: "npm-eneedauth",
            evidence: "https://github.com/openclaw/openclaw/actions/runs/12/job/34",
          },
        ],
      }),
    },
    () => f.approvals,
  );
  expect(deferred).toMatchObject({ version: 4, fastTrackDigest: f.receipt.fastTrackDigest });
  expect(deferred.corePluginDeferrals).toHaveLength(1);
});

it("returns the verified original approval-job timestamp for active and completed publication after expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture();
  vi.setSystemTime(Date.parse(f.packet.request.expiresAt) + 1);
  const archive = await new JSZip()
    .file("approval.json", JSON.stringify(f.receipt))
    .generateAsync({ type: "nodebuffer" });
  const artifact = {
    ...f.artifact,
    size_in_bytes: archive.length,
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    expires_at: "2099-01-01T00:00:00Z",
  };
  const responses: Record<string, unknown> = {
    "actions/runs/10/artifacts?name=openclaw-release-approval-v1-10-2&per_page=100": {
      total_count: 1,
      artifacts: [artifact],
    },
    "actions/runs/10/attempts/2": f.parentRun,
    "actions/runs/10/attempts/2/jobs?per_page=100": f.parentJobs,
    "actions/runs/10/approvals": f.approvals,
  };
  const params = {
    expected: f.expected,
    token: "synthetic",
    runGhJson: (path: string) => responses[path],
    fetchImpl: async (url: string) =>
      url.endsWith("/zip") ? new Response(new Uint8Array(archive)) : Response.json(artifact),
  };
  const download = () =>
    downloadReleaseApprovalReceipt({
      ...params,
      expected: { ...params.expected, parentStatePolicy: "manual-recovery" },
    });
  await expect(downloadReleaseApprovalReceipt(params)).resolves.toMatchObject({
    approvedAt: f.parentJobs.jobs[0]!.started_at,
  });
  f.parentRun.status = "completed";
  f.parentRun.conclusion = "failure";
  await expect(downloadReleaseApprovalReceipt(params)).rejects.toThrow("not allowed by active");
  await expect(download()).resolves.toMatchObject({
    receipt: f.receipt,
    approvedAt: f.parentJobs.jobs[0]!.started_at,
  });
  // Exercise the replay owner through the real receipt verifier, replacing
  // only GitHub transport. A caller's timestamp cannot stand in for a receipt.
  vi.stubEnv("RELEASE_PUBLISH_RUN_ID", "");
  vi.stubEnv("GITHUB_JOB", "");
  await expect(fastTrackAdmissionTime(f.packet)).rejects.toThrow("request expired");
  vi.stubEnv("RELEASE_PUBLISH_RUN_ID", "10");
  vi.stubEnv("RELEASE_PUBLISH_RUN_ATTEMPT", "2");
  vi.spyOn(toolingModule, "runReleaseToolingGh").mockReturnValue(JSON.stringify(f.parentRun));
  const originalDownload = downloadReleaseApprovalReceipt;
  vi.spyOn(receiptModule, "downloadReleaseApprovalReceipt").mockImplementation((input) =>
    originalDownload({ ...params, expected: input.expected }),
  );
  await expect(fastTrackAdmissionTime(f.packet)).resolves.toBe(
    Date.parse(f.parentJobs.jobs[0]!.started_at),
  );
  f.parentJobs.jobs[0]!.started_at = f.packet.request.expiresAt;
  await expect(fastTrackAdmissionTime(f.packet)).rejects.toThrow(
    "did not admit this exact approval before expiry",
  );
  f.parentJobs.jobs[0]!.started_at = "invalid";
  await expect(download()).rejects.toThrow("no valid start timestamp");
});
