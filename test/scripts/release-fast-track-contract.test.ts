import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  exchangeFastTrackApproval,
  verifyFastTrackApproval,
} from "../../scripts/lib/release-fast-track-approval.mts";
import {
  collectFastTrackEligibility,
  fastTrackRequestDigest,
  parseFastTrackRequest,
  serializeFastTrackRequest,
  type FastTrackRequest,
} from "../../scripts/lib/release-fast-track-contract.mts";
import { runReleasePublishPreflightCommand } from "../../scripts/release-publish-preflight.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const digest = `sha256:${"a".repeat(64)}`;
function request(candidateSha = "b".repeat(40), referenceSha = "a".repeat(40)): FastTrackRequest {
  return {
    schemaVersion: 1,
    policy: "approved-fast-track-v1",
    action: "Approve skipping release validation",
    repository: "openclaw/openclaw",
    releaseTag: "v2026.11.2-beta.1",
    channel: "beta",
    candidateSha,
    reference: {
      releaseTag: "v2026.11.1",
      targetSha: referenceSha,
      validationEvidenceDigest: digest,
    },
    delta: { commits: 1, added: 1, deleted: 0 },
    artifacts: [{ name: "openclaw.tgz", digest }],
    publicationScope: ["npm:openclaw:beta"],
    run: { id: "123", attempt: "1" },
    requestId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-11-17T12:00:00.000Z",
  };
}
function history() {
  const root = roots.make("release-fast-track-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Synthetic test");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  function commit(name: string, content: string | Buffer) {
    writeFileSync(join(root, name), content);
    git("add", "--", name);
    git("commit", "-m", "synthetic delta");
    return git("rev-parse", "HEAD");
  }
  const anchor = commit("initial.txt", "published\n");
  return { root, git, commit, anchor };
}
function eligibility(
  root: string,
  value: FastTrackRequest,
  anchorChanges: Record<string, unknown> = {},
) {
  return collectFastTrackEligibility({
    repositoryRoot: root,
    request: value,
    validatedReference: {
      repository: value.repository,
      ...value.reference,
      validationMode: "full-release-validation",
      published: true,
      ...anchorChanges,
    },
  });
}

it("binds all immutable review fields while treating artifact and scope lists as sets", () => {
  const original = request();
  const identity = fastTrackRequestDigest(original);
  expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const changes = [
    { candidateSha: "c".repeat(40) },
    { reference: { ...original.reference, targetSha: "c".repeat(40) } },
    { reference: { ...original.reference, validationEvidenceDigest: `sha256:${"b".repeat(64)}` } },
    { artifacts: [{ name: "openclaw.tgz", digest: `sha256:${"b".repeat(64)}` }] },
    { publicationScope: ["docker:openclaw:beta"] },
    { run: { id: "124", attempt: "1" } },
    { run: { id: "123", attempt: "2" } },
    { expiresAt: "2026-11-17T13:00:00.000Z" },
    { delta: { commits: 2, added: 1, deleted: 0 } },
    { repository: "example/other" },
    { releaseTag: "v2026.11.2-beta.2" },
    { requestId: "00000000-0000-4000-8000-000000000002" },
  ];
  for (const change of changes) {
    expect(fastTrackRequestDigest({ ...original, ...change })).not.toBe(identity);
  }
  const pair = {
    ...original,
    artifacts: [...original.artifacts, { name: "other.tgz", digest }],
    publicationScope: ["npm:other:beta", ...original.publicationScope],
  };
  expect(fastTrackRequestDigest(pair)).toBe(
    fastTrackRequestDigest({
      ...pair,
      artifacts: pair.artifacts.toReversed(),
      publicationScope: pair.publicationScope.toReversed(),
    }),
  );
});

it.each([
  { candidateSha: "HEAD" },
  { candidateSha: "--help" },
  { action: "Approve release" },
  { policy: "authorized-beta-focused-v1" },
  { delta: { commits: -1, added: 0, deleted: 0 } },
  { channel: "latest" },
  { releaseTag: "v2026.11.33", channel: "latest" },
  { releaseTag: "v2026.11.2", channel: "extended-stable" },
  {
    artifacts: [
      { name: "openclaw.tgz", digest },
      { name: "openclaw.tgz", digest },
    ],
  },
  { publicationScope: ["npm:openclaw:beta", "npm:openclaw:beta"] },
  { extra: "unreviewed" },
])("rejects ambiguous or malformed immutable requests %j", (change) => {
  expect(() => parseFastTrackRequest({ ...request(), ...change })).toThrow();
});

it("recomputes complete delta including generated files and detects caller count or anchor mismatches", () => {
  const h = history();
  const candidate = h.commit("generated.txt", "generated\n".repeat(1000));
  const value = { ...request(candidate, h.anchor), delta: { commits: 1, added: 1000, deleted: 0 } };
  expect(eligibility(h.root, value)).toEqual({ commits: 1, added: 1000, deleted: 0 });
  expect(() => eligibility(h.root, { ...value, delta: { ...value.delta, added: 1 } })).toThrow(
    "Publisher-computed delta",
  );
  expect(() => eligibility(h.root, value, { targetSha: candidate })).toThrow(
    "reference does not match",
  );
  expect(() => eligibility(h.root, value, { validationMode: "approved-fast-track-v1" })).toThrow();
  expect(() => eligibility(h.root, value, { published: false })).toThrow();
});

it("counts deletions, accepts 1000 total lines and rejects 1001", () => {
  const h = history();
  const anchor = h.commit("generated.txt", "old\n".repeat(500));
  const candidate = h.commit("generated.txt", "new\n".repeat(500));
  expect(
    eligibility(h.root, {
      ...request(candidate, anchor),
      delta: { commits: 1, added: 500, deleted: 500 },
    }),
  ).toEqual({ commits: 1, added: 500, deleted: 500 });
  const excessive = h.commit("generated.txt", "new\n".repeat(501));
  expect(() =>
    eligibility(h.root, {
      ...request(excessive, anchor),
      delta: { commits: 2, added: 501, deleted: 500 },
    }),
  ).toThrow("at most 1000");
});

it("counts every commit since the validated anchor, not since the last fast-track", () => {
  const h = history();
  let candidate = h.anchor;
  for (let i = 0; i < 10; i++) {
    candidate = h.commit(`file${i}.txt`, "line\n");
  }
  const value = { ...request(candidate, h.anchor), delta: { commits: 10, added: 10, deleted: 0 } };
  expect(eligibility(h.root, value)).toEqual(value.delta);
  candidate = h.commit("eleventh.txt", "line\n");
  expect(() =>
    eligibility(h.root, {
      ...value,
      candidateSha: candidate,
      delta: { commits: 11, added: 11, deleted: 0 },
    }),
  ).toThrow("at most 10 commits");
});

it("rejects binary changes even when candidate attributes force text", () => {
  const h = history();
  h.commit(".gitattributes", "*.bin diff\n");
  const candidate = h.commit("payload.bin", Buffer.from([0, 1, 2]));
  expect(() =>
    eligibility(h.root, {
      ...request(candidate, h.anchor),
      delta: { commits: 2, added: 2, deleted: 0 },
    }),
  ).toThrow("binary change");
});

it("rejects non-ancestor reference commits", () => {
  const h = history();
  const candidate = h.commit("candidate.txt", "candidate\n");
  h.git("checkout", "--orphan", "unrelated");
  const unrelated = h.commit("other.txt", "other\n");
  expect(() => eligibility(h.root, request(candidate, unrelated))).toThrow("must be an ancestor");
});

it("uses the same lowercase UUIDv4 request identity as the independent approval service", () => {
  for (const requestId of [
    "019a8248-1234-7123-8123-123456789abc",
    "A83B87DC-4738-471E-AAF4-B59D89D35523",
  ]) {
    expect(() => parseFastTrackRequest({ ...request(), requestId })).toThrow();
  }
});

it("requires live exact approval after recomputing the publisher delta, not a GitHub actor", async () => {
  const repo = history();
  const candidate = repo.commit("fix.txt", "fix\n");
  const value = {
    ...request(candidate, repo.anchor),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const approval = {
    state: "approved",
    requestId: value.requestId,
    digest: fastTrackRequestDigest(value),
    payload: serializeFastTrackRequest(value),
    expiresAt: value.expiresAt,
    approver: "users/12345",
    approverEmail: "dallin@openclaw.org",
    decidedAt: new Date(Date.now() - 1000).toISOString(),
  };
  let response = approval;
  const fetchApproval = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetchApproval);
  const input = {
    serviceOrigin: "https://approval.example",
    identityToken: "synthetic-request-only-token",
    request: value,
    repositoryRoot: repo.root,
    validatedReference: {
      repository: value.repository,
      ...value.reference,
      validationMode: "full-release-validation" as const,
      published: true as const,
    },
  };
  try {
    await expect(verifyFastTrackApproval(input)).resolves.toMatchObject({
      validation: "validation skipped by approved fast-track",
      approver: "users/12345",
    });
    expect(fetchApproval).toHaveBeenCalledWith(
      `https://approval.example/requests/${value.requestId}`,
      expect.objectContaining({ redirect: "error" }),
    );
    for (const changed of [
      { state: "pending" },
      { state: "rejected" },
      { digest: `sha256:${"0".repeat(64)}` },
      { payload: serializeFastTrackRequest({ ...value, run: { ...value.run, attempt: "2" } }) },
      { approverEmail: "services@openclaw.org" },
      { approver: "github-user" },
      { expiresAt: "2000-01-01T00:00:00Z" },
      { decidedAt: value.expiresAt },
    ]) {
      response = { ...approval, ...changed };
      await expect(verifyFastTrackApproval(input)).rejects.toThrow(
        /mismatched Google Chat approval/u,
      );
    }
    await expect(
      verifyFastTrackApproval({ ...input, serviceOrigin: "http://approval.example" }),
    ).rejects.toThrow(/pinned HTTPS/u);
    await expect(
      verifyFastTrackApproval({
        ...input,
        request: { ...value, delta: { ...value.delta, commits: 2 } },
      }),
    ).rejects.toThrow(/computed delta/u);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("serializes release requests unchanged across the independently deployable service boundary", () => {
  const value = { ...request(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const serviceUrl = new URL("../../deploy/release-approval/service.mjs", import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from 'node:fs';
    import { parseRequest } from ${JSON.stringify(serviceUrl)};
    console.log(JSON.stringify(parseRequest({ payload: readFileSync(0, 'utf8') }, Date.now())));
  `,
    ],
    { input: serializeFastTrackRequest(value), encoding: "utf8" },
  );
  expect(JSON.parse(output)).toMatchObject({
    requestId: value.requestId,
    payload: serializeFastTrackRequest(value),
    digest: fastTrackRequestDigest(value),
    state: "pending",
  });
});

it("submits canonical review bytes and reads only the bound result without any machine approval operation", async () => {
  const value = { ...request(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const payload = serializeFastTrackRequest(value);
  const result = {
    requestId: value.requestId,
    payload,
    digest: fastTrackRequestDigest(value),
    expiresAt: value.expiresAt,
    state: "pending",
  };
  const fetchApproval = vi.fn(async () => new Response(JSON.stringify(result)));
  vi.stubGlobal("fetch", fetchApproval);
  const input = {
    serviceOrigin: "https://approval.example",
    identityToken: "synthetic-request-only",
    request: value,
  };
  try {
    await expect(
      exchangeFastTrackApproval({ ...input, operation: "request" }),
    ).resolves.toMatchObject({ state: "pending" });
    expect(fetchApproval).toHaveBeenLastCalledWith(
      "https://approval.example/requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ payload }),
        redirect: "error",
      }),
    );
    await expect(
      exchangeFastTrackApproval({ ...input, operation: "status" }),
    ).resolves.toMatchObject({ state: "pending" });
    expect(fetchApproval).toHaveBeenLastCalledWith(
      `https://approval.example/requests/${value.requestId}`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    await expect(
      exchangeFastTrackApproval({ ...input, identityToken: "", operation: "request" }),
    ).rejects.toThrow(/identity token/u);
    await expect(
      exchangeFastTrackApproval({
        ...input,
        serviceOrigin: "https://evil.example/path",
        operation: "request",
      }),
    ).rejects.toThrow(/pinned HTTPS/u);
    fetchApproval.mockImplementationOnce(async () => new Response("{}", { status: 403 }));
    await expect(exchangeFastTrackApproval({ ...input, operation: "request" })).rejects.toThrow(
      /HTTP 403/u,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("exposes request/status CLI without token disclosure or a machine approval verb", async () => {
  await expect(
    runReleasePublishPreflightCommand(["approval", "approve", "--request", "unused.json"]),
  ).rejects.toThrow(/no machine approval/u);
  const value = { ...request(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const directory = roots.make("release-fast-track-cli-");
  const file = join(directory, "request.json");
  writeFileSync(file, JSON.stringify(value));
  const result = {
    requestId: value.requestId,
    payload: serializeFastTrackRequest(value),
    digest: fastTrackRequestDigest(value),
    expiresAt: value.expiresAt,
    state: "pending",
  };
  vi.stubEnv("FAST_TRACK_APPROVAL_SERVICE_ORIGIN", "https://approval.example");
  vi.stubEnv("FAST_TRACK_APPROVAL_ID_TOKEN", "synthetic-secret-never-printed");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(result))),
  );
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    for (const operation of ["request", "status"]) {
      await runReleasePublishPreflightCommand(["approval", operation, "--request", file]);
    }
    const text = String(output.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(text)).toMatchObject({ state: "pending", publicationAuthorized: false });
    expect(text).not.toContain("synthetic-secret-never-printed");
  } finally {
    output.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it("does not allow Git submodule-ignore configuration to hide an ineligible gitlink delta", () => {
  const repo = history();
  repo.git("config", "diff.ignoreSubmodules", "all");
  repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.anchor},nested`);
  repo.git("commit", "-m", "synthetic gitlink change");
  const value = {
    ...request(repo.git("rev-parse", "HEAD"), repo.anchor),
    delta: { commits: 1, added: 0, deleted: 0 },
  };
  expect(() => eligibility(repo.root, value)).toThrow(/unmeasurable/u);
});

it("never prints a malformed identity token when Node rejects an Authorization header", () => {
  const directory = roots.make("release-fast-track-token-");
  const file = join(directory, "request.json");
  writeFileSync(file, JSON.stringify(request()));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/release-publish-preflight.mts",
      "approval",
      "status",
      "--request",
      file,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAST_TRACK_APPROVAL_SERVICE_ORIGIN: "https://approval.example",
        FAST_TRACK_APPROVAL_ID_TOKEN: "DO-NOT-PRINT-THIS-SYNTHETIC-CREDENTIAL\ninvalid",
      },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("well-formed request-only or read-only Google identity token");
  expect(result.stderr).not.toContain("DO-NOT-PRINT-THIS-SYNTHETIC-CREDENTIAL");
  expect(result.stdout).not.toContain("DO-NOT-PRINT-THIS-SYNTHETIC-CREDENTIAL");
});

it("does not propagate HTTP-client errors that echo Authorization credentials", async () => {
  const token = "synthetic.header.signature";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError(`Invalid Authorization header: Bearer ${token}`);
    }),
  );
  try {
    await expect(
      exchangeFastTrackApproval({
        serviceOrigin: "https://approval.example",
        identityToken: token,
        request: request(),
        operation: "status",
      }),
    ).rejects.toThrow("Approval service transport failed.");
  } finally {
    vi.unstubAllGlobals();
  }
});
