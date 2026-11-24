import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectFastTrackEligibility,
  fastTrackRequestDigest,
  parseFastTrackRequest,
  serializeFastTrackRequest,
  type FastTrackRequest,
} from "../scripts/lib/release-fast-track-contract.mts";
import { runReleasePublishPreflightCommand } from "../scripts/release-publish-preflight.mts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

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
  // Existing v1 approval records bind these exact field-order bytes.
  expect(serializeFastTrackRequest(original)).toBe(JSON.stringify(original));
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
  const candidate = h.commit("generated.txt", "generated\n".repeat(10000));
  const value = {
    ...request(candidate, h.anchor),
    delta: { commits: 1, added: 10000, deleted: 0 },
  };
  expect(eligibility(h.root, value)).toEqual({ commits: 1, added: 10000, deleted: 0 });
  expect(() => eligibility(h.root, { ...value, delta: { ...value.delta, added: 1 } })).toThrow(
    "Publisher-computed delta",
  );
  expect(() => eligibility(h.root, value, { targetSha: candidate })).toThrow(
    "reference does not match",
  );
  expect(() => eligibility(h.root, value, { validationMode: "approved-fast-track-v1" })).toThrow();
  expect(() => eligibility(h.root, value, { published: false })).toThrow();
});

it("counts deletions, accepts 10000 total lines and rejects 10001", () => {
  const h = history();
  const anchor = h.commit("generated.txt", "old\n".repeat(5000));
  const candidate = h.commit("generated.txt", "new\n".repeat(5000));
  expect(
    eligibility(h.root, {
      ...request(candidate, anchor),
      delta: { commits: 1, added: 5000, deleted: 5000 },
    }),
  ).toEqual({ commits: 1, added: 5000, deleted: 5000 });
  const excessive = h.commit("generated.txt", "new\n".repeat(5001));
  expect(() =>
    eligibility(h.root, {
      ...request(excessive, anchor),
      delta: { commits: 2, added: 5001, deleted: 5000 },
    }),
  ).toThrow("at most 10000");
});

it("excludes only package manifests and known lockfiles from LOC, including nested paths", () => {
  const h = history();
  mkdirSync(join(h.root, "nested"));
  for (const file of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]) {
    h.commit(`nested/${file}`, "dependency\n".repeat(10001));
  }
  const candidate = h.commit("package-helper.ts", "source\n".repeat(10000));
  const value = {
    ...request(candidate, h.anchor),
    delta: { commits: 8, added: 10000, deleted: 0 },
  };
  expect(eligibility(h.root, value)).toEqual(value.delta);
  const excessive = h.commit("package.json.backup", "still counted\n");
  expect(() => eligibility(h.root, { ...value, candidateSha: excessive })).toThrow("at most 10000");
  const binary = h.commit("nested/bun.lockb", Buffer.from([0, 1, 2]));
  expect(() => eligibility(h.root, { ...value, candidateSha: binary })).toThrow("binary change");
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

it("requires a lowercase UUIDv4 immutable request identity", () => {
  for (const requestId of [
    "019a8248-1234-7123-8123-123456789abc",
    "A83B87DC-4738-471E-AAF4-B59D89D35523",
  ]) {
    expect(() => parseFastTrackRequest({ ...request(), requestId })).toThrow();
  }
});

it("prepares an exact local packet without credentials, network access or approval authority", async () => {
  const value = { ...request(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const file = join(roots.make("release-fast-track-cli-"), "request.json");
  writeFileSync(file, JSON.stringify(value));
  const network = vi.fn(() => {
    throw new Error("Must not call a service");
  });
  vi.stubGlobal("fetch", network);
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runReleasePublishPreflightCommand(["approval", "request", "--request", file]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      requestId: value.requestId,
      digest: fastTrackRequestDigest(value),
      payload: serializeFastTrackRequest(value),
      state: "awaiting-explicit-maintainer-approval",
      publicationAuthorized: false,
    });
    expect(network).not.toHaveBeenCalled();
    for (const operation of ["approve", "status", "reject"]) {
      await expect(
        runReleasePublishPreflightCommand(["approval", operation, "--request", file]),
      ).rejects.toThrow(/no machine approval/u);
    }
    writeFileSync(file, JSON.stringify({ ...value, expiresAt: "2000-01-01T00:00:00.000Z" }));
    await expect(
      runReleasePublishPreflightCommand(["approval", "request", "--request", file]),
    ).rejects.toThrow(/fresh expiry/u);
  } finally {
    output.mockRestore();
    vi.unstubAllGlobals();
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

it("binds a separate partial-FRV approval to retained results without relaxing small-delta admission", async () => {
  const original = request();
  const partial = {
    ...original,
    policy: "approved-partial-frv-v1",
    action: "Approve publication with incomplete validation",
    reason: "Accept the explicitly listed validation gaps for these exact artifacts.",
    delta: { commits: 83, added: 90000, deleted: 420 },
    validationSnapshot: {
      runId: "456",
      runAttempt: "2",
      candidateSha: original.candidateSha,
      capturedAt: "2026-11-17T11:00:00.000Z",
      evidenceUrl:
        "https://github.com/openclaw/openclaw/releases/download/example/frv-snapshot.json",
      evidenceDigest: digest,
      summary: { passed: 47, failed: 1, cancelled: 0, skipped: 0, unfinished: 1 },
      outstandingChecks: [
        { name: "Windows startup", status: "failed", jobId: "501", runId: "457", runAttempt: "1" },
        { name: "Soak", status: "unfinished", jobId: "502", runId: "458", runAttempt: "1" },
      ],
    },
  };
  expect(parseFastTrackRequest(partial)).toMatchObject({
    policy: partial.policy,
    delta: partial.delta,
  });
  for (const change of [
    { action: original.action },
    { validationSnapshot: undefined },
    { validationSnapshot: { ...partial.validationSnapshot, candidateSha: "f".repeat(40) } },
    {
      validationSnapshot: {
        ...partial.validationSnapshot,
        summary: { ...partial.validationSnapshot.summary, failed: 0 },
      },
    },
    {
      validationSnapshot: {
        ...partial.validationSnapshot,
        summary: { ...partial.validationSnapshot.summary, passed: 0 },
      },
    },
    {
      validationSnapshot: {
        ...partial.validationSnapshot,
        evidenceUrl: "https://example.invalid/untrusted",
      },
    },
  ]) {
    expect(() => parseFastTrackRequest({ ...partial, ...change })).toThrow();
  }
  const changedSnapshot = { ...partial.validationSnapshot, runAttempt: "3" };
  expect(fastTrackRequestDigest({ ...partial, validationSnapshot: changedSnapshot })).not.toBe(
    fastTrackRequestDigest(partial),
  );
  expect(() =>
    collectFastTrackEligibility({
      request: parseFastTrackRequest(partial),
      repositoryRoot: "unused",
      validatedReference: {
        repository: original.repository,
        ...original.reference,
        validationMode: "full-release-validation",
        published: true,
      },
    }),
  ).toThrow(/authenticated partial-FRV evidence/u);
  expect(() =>
    parseFastTrackRequest({ ...partial, policy: original.policy, action: original.action }),
  ).toThrow();
});
