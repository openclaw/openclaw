import { createHash } from "node:crypto";
import { writeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectActionsArtifactZipWithPolicy } from "../../scripts/lib/actions-artifact-archive.mjs";
import { createReleaseEvidenceReplay } from "../../scripts/lib/release-evidence-replay.mjs";
import {
  loadNpmEvidenceReplay,
  npmEvidenceBinding,
  npmEvidenceArtifactName,
} from "../../scripts/plugin-npm-evidence-reuse.mjs";
import {
  authenticatePreparedNpmArtifact,
  preparedNpmArtifactName,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const transport = vi.hoisted(() => ({
  read: (_args: readonly string[]): unknown => {
    throw new Error("Unconfigured transport");
  },
}));
vi.mock("../../scripts/lib/plain-gh.mjs", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/plain-gh.mjs")>()),
  execGhRead: (args: string[]) => transport.read(args),
  execGhReadAsync: async (args: string[]) => transport.read(args),
  execPlainGh: (args: string[]) => transport.read(args),
  resolvePlainGhBin: () => "/synthetic/gh",
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (
      file: string,
      args: readonly string[],
      options: import("node:child_process").ExecFileSyncOptions,
    ) => {
      if (file === "unzip") {
        // Fixture the external extractor only; production digest and manifest
        // validators still consume the raw ZIP. No native unzip is required.
        const zipPath = args[0] === "-Z" ? args[2]! : args[1]!;
        const files = inspectActionsArtifactZipWithPolicy(readFileSync(zipPath), {
          minEntries: 1,
          maxEntries: 1,
          allowPath: () => true,
          maxEntryBytes: () => 1024 * 1024,
        });
        return args[0] === "-Z" ? [...files.keys()].join("\n") + "\n" : files.get(args[2]!);
      }
      if (file !== "/synthetic/gh") {
        return actual.execFileSync(file, args, options);
      }
      const body = transport.read(args);
      if (
        !(body instanceof Uint8Array) ||
        !Array.isArray(options.stdio) ||
        typeof options.stdio[1] !== "number"
      ) {
        throw new Error("Expected raw archive transport");
      }
      writeSync(options.stdio[1], body);
      return Buffer.alloc(0);
    },
  };
});
afterEach(() => vi.unstubAllEnvs());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(pageHeavy = false, sameSha = false) {
  const f = candidatePublicationFixture(sameSha ? { candidateSha: "b".repeat(40) } : {});
  const descriptor = {
    repository: f.repository,
    runId: 101,
    runAttempt: 1,
    workflowPath: ".github/workflows/plugin-npm-release.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: f.branch,
    workflowSha: f.q,
    artifactId: 9001,
    artifactName: "",
    artifactDigest: "sha256:" + "d".repeat(64),
    artifactSizeBytes: 100,
  };
  descriptor.artifactName = preparedNpmArtifactName(f.q, descriptor);
  Object.assign(f.manifest.publicationArtifacts, { pluginNpm: descriptor });
  const archives = new Map([
    [91, makeStoredZip({ "full-release-validation-manifest.json": JSON.stringify(f.manifest) })],
    [92, makeStoredZip({ "full-release-execution-plan.json": JSON.stringify(f.plan) })],
    [70, f.admission.archive()],
  ]);
  const artifacts = new Map(
    [...archives].map(([id, bytes]) => [
      id,
      id === 70
        ? f.admission.metadata
        : {
            id,
            name:
              id === 91
                ? "full-release-validation-" + f.runId + "-1"
                : "full-release-execution-plan-" + f.runId,
            digest: "sha256:" + digest(bytes),
            size_in_bytes: bytes.length,
            expired: false,
            expires_at: "2099-01-01T00:00:00Z",
            created_at: "2026-08-28T12:01:02.000Z",
            workflow_run: { id: Number(f.runId), head_sha: f.q, head_branch: f.branch },
          },
    ]),
  );
  const calls: string[] = [];
  const raw = (args: readonly string[]): unknown => {
    if (args[0] === "run") {
      calls.push("run view " + f.runId);
      return JSON.stringify(f.client.getRunView(f.runId));
    }
    const route = args[1]!.replace("repos/" + f.repository + "/", "");
    calls.push(route);
    const done = (value: unknown) =>
      typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value);
    if (route === "actions/runs/40") {
      return done(f.admission.run);
    }
    const archive = /^actions\/artifacts\/(\d+)\/zip$/u.exec(route);
    if (archive) {
      return archives.get(Number(archive[1]));
    }
    const artifact = /^actions\/artifacts\/(\d+)$/u.exec(route);
    if (artifact) {
      return done(artifacts.get(Number(artifact[1])));
    }
    if (
      route.startsWith("git/ref/") ||
      route.startsWith("collaborators/") ||
      route.startsWith("actions/runs/40/") ||
      (route.startsWith("contents/") && !route.includes("plugin-npm-release.yml"))
    ) {
      return f.admission.runGh([...args]);
    }
    if (route.startsWith("contents/")) {
      const text = "name: immutable npm policy\n";
      return done({
        type: "file",
        path: ".github/workflows/plugin-npm-release.yml",
        encoding: "base64",
        size: text.length,
        content: Buffer.from(text).toString("base64"),
        sha: createHash("sha1")
          .update("blob " + text.length + "\0" + text)
          .digest("hex"),
      });
    }
    const run = /^actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/u.exec(route);
    if (run) {
      return run[2]
        ? done(f.client.getRunAttempt(run[1]!, Number(run[2])))
        : Promise.resolve(f.client.getRun(run[1]!)).then(done);
    }
    if (route.includes("/artifacts?")) {
      return done({ total_count: 2, artifacts: [artifacts.get(91), artifacts.get(92)] });
    }
    const jobs = /^actions\/runs\/(\d+)\/(?:attempts\/(\d+)\/)?jobs\?/u.exec(route);
    if (jobs) {
      if (jobs[2] && route.includes("per_page=100")) {
        throw new Error("fixture (HTTP 502)");
      }
      const list = jobs[2]
        ? f.client.getRunAttemptJobs(jobs[1]!)
        : f.client.getParentJobs(jobs[1]!);
      return Promise.resolve(list).then((original) => {
        const listing =
          pageHeavy && jobs[1] !== f.runId
            ? [
                ...original,
                ...Array.from({ length: 900 }, (_, index) => ({
                  ...original[0],
                  id: 10000 + index,
                  name: "Skipped matrix " + index,
                  status: "completed",
                  conclusion: "skipped",
                })),
              ]
            : original;
        const query = new URLSearchParams(route.split("?")[1]);
        const perPage = Number(query.get("per_page"));
        const start = (Number(query.get("page") ?? 1) - 1) * perPage;
        return done({ total_count: listing.length, jobs: listing.slice(start, start + perPage) });
      });
    }
    const log = /^actions\/jobs\/(\d+)\/logs$/u.exec(route);
    if (log) {
      return f.client.getJobLog(Number(log[1]));
    }
    throw new Error("Unexpected raw request: " + route);
  };
  transport.read = raw;
  return {
    f,
    artifacts,
    archives,
    calls,
    params: {
      repository: f.repository,
      sourceSha: f.q,
      workflowSha: f.p,
      workflowFullRef: f.publisherFullRef,
      artifact: descriptor,
      fullReleaseValidationRunId: f.runId,
      fullReleaseValidationRunAttempt: 1,
      releaseTag: "v" + f.source.projection?.version,
      selectionMode: "all-publishable",
      plugins: "",
      npmDistTag: "default",
    },
  };
}

it.each([false, true])(
  "replays strict evidence for 98 consumers (pagination-heavy=%s)",
  async (pageHeavy) => {
    const { params, calls } = fixture(pageHeavy);
    const baseline = await authenticatePreparedNpmArtifact(params);
    await baseline.revalidateAuthority?.();
    const baselinePerGate = calls.length;
    calls.length = 0;
    const writer = createReleaseEvidenceReplay(params);
    const before = await authenticatePreparedNpmArtifact({ ...params, immutableReads: writer });
    await before.revalidateAuthority?.();
    const captureCalls = calls.length;
    const payload = JSON.parse(writer.serialize());
    calls.length = 0;
    for (let index = 0; index < 98; index += 1) {
      const reader = createReleaseEvidenceReplay(params, payload);
      const adopted = await authenticatePreparedNpmArtifact({ ...params, immutableReads: reader });
      expect(adopted.artifact).toEqual(before.artifact);
      await adopted.revalidateAuthority?.();
    }
    expect(
      calls.some(
        (route) =>
          route.endsWith("/zip") || route.endsWith("/logs") || route.startsWith("contents/"),
      ),
    ).toBe(false);
    expect(calls.some((route) => route.includes("collaborators/"))).toBe(true);
    expect(calls.some((route) => route.includes("git/ref/"))).toBe(true);
    expect(calls.some((route) => route.includes("per_page=50"))).toBe(false);
    console.log(
      JSON.stringify({
        pageHeavy,
        baselinePerGate,
        captureCalls,
        consumers: 98,
        replayCalls: calls.length,
        baselineProjection98: baselinePerGate * 98,
        payloadBytes: Buffer.byteLength(writer.serialize()),
      }),
    );
    if (pageHeavy) {
      expect(calls.length + captureCalls).toBeLessThan((baselinePerGate * 98) / 2);
    }
  },
);

it("keeps nonterminal historical job pages live without serializing their status", async () => {
  const route = "actions/runs/101/attempts/1/jobs?per_page=100&page=1";
  const raw = JSON.stringify({ total_count: 1, jobs: [{ id: 123, status: "queued" }] });
  const writer = createReleaseEvidenceReplay({});
  expect(await writer.text(route, () => raw)).toBe(raw);
  const payload = JSON.parse(writer.serialize());
  expect(payload.entries).toEqual([]);
  const reader = createReleaseEvidenceReplay({}, payload);
  const fresh = vi.fn(() => raw);
  expect(await reader.text(route, fresh)).toBe(raw);
  expect(fresh).toHaveBeenCalledOnce();
  expect(() => reader.text("actions/jobs/123/logs", fresh)).toThrow(/Missing immutable/);
});

it("rejects poisoning and cross-attempt reuse before strict verification", async () => {
  const { params } = fixture();
  const writer = createReleaseEvidenceReplay(params);
  await authenticatePreparedNpmArtifact({ ...params, immutableReads: writer });
  const payload = JSON.parse(writer.serialize());
  expect(() =>
    createReleaseEvidenceReplay({ ...params, fullReleaseValidationRunAttempt: 2 }, payload),
  ).toThrow(/differs/);
  const poisoned = structuredClone(payload);
  poisoned.entries[0][1].data += "poison";
  expect(() => createReleaseEvidenceReplay(params, poisoned)).toThrow(/digest/);
  expect(() =>
    createReleaseEvidenceReplay(params).text("actions/jobs/999999/logs", () =>
      "x".repeat(16 * 1024 * 1024 + 1),
    ),
  ).toThrow(/size/);
  const mutable = structuredClone(payload);
  mutable.entries[0][0] = "collaborators/admin/permission";
  expect(() => createReleaseEvidenceReplay(params, mutable)).toThrow(/Invalid/);
});

it.each(["permission", "tag", "frv", "artifact"])(
  "refuses %s changes after replay before the mutation",
  async (fault) => {
    const { params, f, artifacts } = fixture();
    const writer = createReleaseEvidenceReplay(params);
    await authenticatePreparedNpmArtifact({ ...params, immutableReads: writer });
    const replay = createReleaseEvidenceReplay(params, JSON.parse(writer.serialize()));
    const adopted = await authenticatePreparedNpmArtifact({ ...params, immutableReads: replay });
    if (fault === "permission") {
      f.admission.authority.permission = "read";
    }
    if (fault === "tag") {
      f.admission.authority.tagSha = "f".repeat(40);
    }
    if (fault === "frv") {
      f.parent.run_attempt += 1;
    }
    if (fault === "artifact") {
      artifacts.get(91)!.expired = true;
    }
    const mutation = vi.fn();
    await expect(
      Promise.resolve().then(async () => {
        await adopted.revalidateAuthority?.();
        mutation();
      }),
    ).rejects.toThrow();
    expect(mutation).not.toHaveBeenCalled();
  },
);

async function carrierFixture() {
  const { params, f } = fixture();
  const binding = npmEvidenceBinding(params, {
    PREPARED_NPM_PARENT_RUN_ID: "700",
    PREPARED_NPM_PARENT_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "800",
    GITHUB_RUN_ATTEMPT: "2",
  });
  const writer = createReleaseEvidenceReplay(binding);
  await authenticatePreparedNpmArtifact({ ...params, immutableReads: writer });
  const payload = JSON.parse(writer.serialize());
  const zip = makeStoredZip({ "plugin-npm-evidence.json": JSON.stringify(payload) });
  const run = {
    id: 800,
    run_attempt: 2,
    head_sha: f.p,
    head_branch: binding.verifierRef.replace(/^refs\/(heads|tags)\//u, ""),
    repository: { full_name: f.repository },
    head_repository: { full_name: f.repository },
    path: ".github/workflows/plugin-npm-release.yml",
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
  };
  const metadata = {
    id: 900,
    name: npmEvidenceArtifactName(binding),
    digest: "sha256:" + digest(zip),
    size_in_bytes: zip.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: run.id, head_sha: f.p },
  };
  const jobs = Array.from({ length: 101 }, (_, i) => ({
    id: 1000 + i,
    name: i === 100 ? "preview_plugins_npm" : "other " + i,
    run_id: run.id,
    run_attempt: 2,
    head_sha: f.p,
    status: "completed",
    conclusion: "success",
  }));
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/artifacts/900")) {
      return Response.json(metadata);
    }
    if (url.pathname.endsWith("/attempts/2")) {
      return Response.json(run);
    }
    if (url.pathname.endsWith("/jobs")) {
      const start = (Number(url.searchParams.get("page") ?? "1") - 1) * 100;
      return Response.json({ total_count: jobs.length, jobs: jobs.slice(start, start + 100) });
    }
    if (url.pathname.endsWith("/zip")) {
      return new Response(Uint8Array.from(zip));
    }
    throw new Error("Unexpected handoff route " + url.pathname);
  };
  const client = {
    getRun: async () => {
      calls.push("current-run");
      return run;
    },
    getArtifact: async () => {
      calls.push("metadata");
      return metadata;
    },
  };
  const originalRead = transport.read;
  transport.read = (args) => {
    const route = args[1]?.replace("repos/" + f.repository + "/", "");
    if (route === "actions/runs/800") {
      return JSON.stringify(run);
    }
    if (route === "actions/artifacts/900") {
      return JSON.stringify(metadata);
    }
    return originalRead(args);
  };
  const paramsForLoad = {
    binding,
    artifactId: 900,
    artifactDigest: digest(zip),
    token: "synthetic-token",
    archivePath: join(tempDirs.make("npm-evidence-"), "evidence.zip"),
    client,
    fetchImpl,
  };
  return { payload, params, paramsForLoad, run, metadata, jobs, calls };
}

it("authenticates the trusted handoff through the full 101-job inventory, then replays strict validators", async () => {
  const f = await carrierFixture();
  const replay = await loadNpmEvidenceReplay(f.paramsForLoad);
  expect(f.calls.some((route) => route.includes("page=2"))).toBe(true);
  const handoffCalls = f.calls.length;
  const adopted = await authenticatePreparedNpmArtifact({ ...f.params, immutableReads: replay });
  await adopted.revalidateAuthority?.();
  expect(adopted.artifact).toEqual(f.params.artifact);
  console.log(JSON.stringify({ authenticatedHandoffCalls: handoffCalls, jobs: 101 }));
  f.metadata.expired = true;
  await expect(adopted.revalidateAuthority?.()).rejects.toThrow(/expired/);
});

it.each([
  "current-attempt",
  "candidate-producer",
  "expiry",
  "producer-job",
  "partial-page",
  "digest",
])("rejects unauthenticated handoff: %s", async (fault) => {
  const f = await carrierFixture();
  if (fault === "current-attempt") {
    f.run.run_attempt += 1;
  }
  if (fault === "candidate-producer") {
    f.run.head_sha = f.params.sourceSha;
  }
  if (fault === "expiry") {
    f.metadata.expires_at = "2000-01-01T00:00:00Z";
  }
  if (fault === "producer-job") {
    f.jobs[100]!.conclusion = "failure";
  }
  if (fault === "partial-page") {
    f.jobs[0]!.id = f.jobs[100]!.id;
  }
  if (fault === "digest") {
    f.metadata.digest = "sha256:" + "0".repeat(64);
  }
  await expect(loadNpmEvidenceReplay(f.paramsForLoad)).rejects.toThrow();
});

it.each([
  "parentRunId",
  "parentRunAttempt",
  "childRunId",
  "childRunAttempt",
  "sourceSha",
  "verifierSha",
  "selectionMode",
])("rejects cross-publication handoff binding: %s", async (field) => {
  const f = await carrierFixture();
  const binding = { ...f.paramsForLoad.binding, [field]: "different" };
  expect(() => createReleaseEvidenceReplay(binding, f.payload)).toThrow(/differs/);
});

it("replays raw responses through semantic validators, not just their content hashes", async () => {
  const { params } = fixture();
  const writer = createReleaseEvidenceReplay(params);
  await authenticatePreparedNpmArtifact({ ...params, immutableReads: writer });
  const payload = JSON.parse(writer.serialize());
  const entry = payload.entries.find(([route]: [string]) =>
    route.startsWith("contents/.github/workflows/plugin-npm-release"),
  );
  const body = JSON.parse(entry[1].data);
  body.sha = "0".repeat(40);
  entry[1].data = JSON.stringify(body);
  entry[1].sha256 = digest(entry[1].data);
  await expect(
    authenticatePreparedNpmArtifact({
      ...params,
      immutableReads: createReleaseEvidenceReplay(params, payload),
    }),
  ).rejects.toThrow(/blob mismatch/);
});

it("captures the policy source needed by later same-SHA authorizers without a local policy file", async () => {
  const { params } = fixture(false, true);
  const publisherPolicySha256 = digest("name: immutable npm policy\n");
  const writer = createReleaseEvidenceReplay(params);
  const preview = await authenticatePreparedNpmArtifact({
    ...params,
    publisherPolicySha256,
    immutableReads: writer,
  });
  const adopted = await authenticatePreparedNpmArtifact({
    ...params,
    immutableReads: createReleaseEvidenceReplay(params, JSON.parse(writer.serialize())),
  });
  expect(adopted.publisherPolicySha256).toBe(preview.publisherPolicySha256);
});
