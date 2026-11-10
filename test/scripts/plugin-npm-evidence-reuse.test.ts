import { createHash } from "node:crypto";
import { existsSync, writeSync, readFileSync } from "node:fs";
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
  downloadPreparedNpmRelease,
  main,
  PREPARED_NPM_MANIFEST,
  preparedNpmArtifactName,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { createPluginPublicationArtifact } from "../../scripts/plugin-publication-artifact.mjs";
import { createReleaseEvidenceClient } from "../../scripts/release-ci-summary.mjs";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { packNpmFixture } from "./plugin-npm-publication-readback.test-support.js";

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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
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

it("replays completed attempts and SHA lineage through the real evidence client", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const run = { id: 40, run_attempt: 1, status: "completed", conclusion: "success" };
  transport.read = vi.fn(() => JSON.stringify(run));
  const writer = createReleaseEvidenceReplay({});
  const client = createReleaseEvidenceClient("openclaw/openclaw", { immutableReads: writer });
  const read = (owner: ReturnType<typeof createReleaseEvidenceClient>) => [
    owner.getRunAttempt(40, 1),
    owner.compareCommitLineage(base, head),
    owner.compareCommits(base, head),
  ];
  const expected = read(client);
  expect(transport.read).toHaveBeenCalledTimes(3);
  transport.read = vi.fn(() => {
    throw new Error("immutable evidence reacquired");
  });
  const replay = createReleaseEvidenceReplay({}, JSON.parse(writer.serialize()));
  expect(
    read(createReleaseEvidenceClient("openclaw/openclaw", { immutableReads: replay })),
  ).toEqual(expected);
  expect(transport.read).not.toHaveBeenCalled();
  transport.read = vi.fn(() => JSON.stringify({ status: "ahead" }));
  client.compareCommitLineage(base, "main");
  createReleaseEvidenceClient("openclaw/openclaw", { immutableReads: replay }).compareCommitLineage(
    base,
    "main",
  );
  expect(transport.read).toHaveBeenCalledTimes(2);
});

it("keeps nonterminal exact attempts live and rejects them in retained payloads", () => {
  const route = "actions/runs/40/attempts/1";
  const raw = JSON.stringify({ status: "in_progress" });
  const writer = createReleaseEvidenceReplay({});
  expect(writer.text(route, () => raw)).toBe(raw);
  const payload = JSON.parse(writer.serialize());
  expect(payload.entries).toEqual([]);
  const fresh = vi.fn(() => raw);
  expect(createReleaseEvidenceReplay({}, payload).text(route, fresh)).toBe(raw);
  expect(fresh).toHaveBeenCalledOnce();
  payload.entries.push([route, { kind: "text", data: raw, sha256: digest(raw) }]);
  expect(() => createReleaseEvidenceReplay({}, payload)).toThrow(/Only completed exact-attempt/);
});

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

async function carrierFixture(prepare?: (source: ReturnType<typeof fixture>) => Promise<void>) {
  const source = fixture();
  await prepare?.(source);
  const { params, f } = source;
  if (prepare) {
    const archive = makeStoredZip({
      "full-release-validation-manifest.json": JSON.stringify(f.manifest),
    });
    source.archives.set(91, archive);
    Object.assign(source.artifacts.get(91)!, {
      digest: "sha256:" + digest(archive),
      size_in_bytes: archive.length,
    });
  }
  const binding = npmEvidenceBinding(params, {
    PREPARED_NPM_PARENT_RUN_ID: "700",
    PREPARED_NPM_PARENT_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "800",
    GITHUB_RUN_ATTEMPT: "2",
  });
  const writer = createReleaseEvidenceReplay(binding);
  const adopted = await authenticatePreparedNpmArtifact({ ...params, immutableReads: writer });
  if (prepare) {
    await downloadPreparedNpmRelease({
      ...params,
      ...adopted,
      token: "synthetic-token",
      fetchImpl: async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = await transport.read(["api", url.pathname.slice(1) + url.search]);
        return body instanceof Uint8Array
          ? new Response(Uint8Array.from(body))
          : new Response(String(body));
      },
    });
  }
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
      source.calls.push(route);
      return JSON.stringify(run);
    }
    if (route === "actions/artifacts/900") {
      source.calls.push(route);
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
  return { payload, params, paramsForLoad, run, metadata, jobs, calls, source };
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

function cliEnvironment(f: Awaited<ReturnType<typeof carrierFixture>>, root: string) {
  const values = {
    GITHUB_REPOSITORY: f.params.repository,
    GITHUB_WORKFLOW_SHA: f.params.workflowSha,
    GITHUB_REF: f.params.workflowFullRef,
    GITHUB_RUN_ID: "800",
    GITHUB_RUN_ATTEMPT: "2",
    GH_TOKEN: "synthetic-token",
    RUNNER_TEMP: root,
    PREPARED_NPM_PARENT_RUN_ID: "700",
    PREPARED_NPM_PARENT_RUN_ATTEMPT: "1",
    PREPARED_NPM_ARTIFACT: JSON.stringify(f.params.artifact),
    PREPARED_NPM_FRV_RUN_ID: f.params.fullReleaseValidationRunId,
    PREPARED_NPM_FRV_RUN_ATTEMPT: "1",
    PREPARED_NPM_SELECTION_MODE: f.params.selectionMode,
    PREPARED_NPM_PLUGINS: "",
    PREPARED_NPM_DIST_TAG: "default",
    PREPARED_NPM_EVIDENCE_ID: "900",
    PREPARED_NPM_EVIDENCE_DIGEST: f.paramsForLoad.artifactDigest,
  };
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value);
  }
  vi.stubGlobal("fetch", f.paramsForLoad.fetchImpl);
}

it("preserves the public return-time gate but removes exactly one CLI combined gate", async () => {
  const f = await carrierFixture();
  const root = tempDirs.make("npm-cli-authorize-");
  cliEnvironment(f, root);
  const client = createReleaseEvidenceClient(f.params.repository);
  f.source.calls.length = 0;
  f.calls.length = 0;
  const replay = await loadNpmEvidenceReplay({ ...f.paramsForLoad, client });
  const revalidate = vi.spyOn(replay, "revalidate");
  const adopted = await authenticatePreparedNpmArtifact({ ...f.params, immutableReads: replay });
  expect(revalidate).toHaveBeenCalledOnce();
  const beforeFinal = f.source.calls.length;
  await adopted.revalidateAuthority?.();
  const finalGateCalls = f.source.calls.slice(beforeFinal);
  expect(revalidate).toHaveBeenCalledTimes(2);
  const publicCalls = [...f.source.calls];
  const publicFetchCalls = f.calls.length;
  f.source.calls.length = 0;
  f.calls.length = 0;
  await main(["authorize", "--source-sha", f.params.sourceSha]);
  const removed = publicCalls.length - f.source.calls.length;
  // Compare the real final callback with the eliminated identical boundary.
  // The raw fixture graph is smaller than the saved production trace.
  expect(removed).toBe(finalGateCalls.length);
  // The completed admission attempt and job page replay; its current run and
  // permissions remain live. Exact-attempt replay and the shared same-actor
  // permission check remove two of the original 17 reads.
  expect(finalGateCalls).not.toContain("actions/runs/40/attempts/1/jobs?per_page=100");
  expect(finalGateCalls).not.toContain("actions/runs/40/attempts/1");
  expect(finalGateCalls).toEqual(
    expect.arrayContaining([
      "actions/artifacts/70",
      "actions/runs/40",
      "collaborators/release-operator/permission",
    ]),
  );
  expect(removed).toBe(15);
  expect(f.calls.length).toBe(publicFetchCalls);
  expect(f.source.calls.filter((route) => route === "actions/runs/800")).toHaveLength(2);
  console.log(
    JSON.stringify({
      publicCalls: publicCalls.length + publicFetchCalls,
      cliCalls: f.source.calls.length + f.calls.length,
      removedCombinedGate: removed,
      finalGateCalls,
    }),
  );
});

async function cliPackageFixture() {
  const root = tempDirs.make("npm-cli-package-");
  let entry: { artifact: ReturnType<typeof fixture>["params"]["artifact"]; [key: string]: unknown };
  let packageJson = "";
  const packageArchives = new Map<number, Buffer>();
  const f = await carrierFixture(async (source) => {
    const producer = { ...source.params.artifact };
    const version = "2026.9.2-beta.1";
    const { packageDir } = writePublishablePluginFixture(root, {
      extensionId: "demo",
      version,
      publishTo: "npm",
    });
    packageJson = join(packageDir, "package.json");
    const sourceBytes = readFileSync(packageJson);
    const artifactDir = join(root, "artifact");
    const tarball = join(artifactDir, "demo.tgz");
    await packNpmFixture(join(root, "packed"), tarball, {
      "package.json": sourceBytes,
      "openclaw.plugin.json": JSON.stringify({ id: "demo" }),
      "dist/index.js": "export default {};",
    });
    const artifactName = "plugin-npm-package-demo-" + version + "-npm-oidc-101-1";
    const created = createPluginPublicationArtifact({
      artifactDir,
      artifactName,
      packageDir: "extensions/demo",
      packageName: "@openclaw/demo",
      version,
      publishTag: "beta",
      route: "npm-oidc",
      targetSha: source.params.sourceSha,
      sourcePackageJsonSha256: digest(sourceBytes),
      publicationReason: "Stable npm registry preflight selected npm-oidc.",
      publisherPolicy: {
        policyId: "plugin-npm-release-workflow",
        schema: "openclaw.plugin-npm-publisher-policy/v1",
        sha256: digest("name: immutable npm policy\n"),
      },
    });
    const packageZip = makeStoredZip({
      "demo.tgz": readFileSync(tarball),
      "plugin-publication-manifest.json": readFileSync(created.manifestPath),
    });
    entry = {
      extensionId: "demo",
      packageDir: "extensions/demo",
      packageName: "@openclaw/demo",
      version,
      channel: "beta",
      publishTag: "beta",
      installNpmSpec: "@openclaw/demo",
      route: "npm-oidc",
      artifact: {
        ...producer,
        artifactId: 9002,
        artifactName,
        artifactDigest: "sha256:" + digest(packageZip),
        artifactSizeBytes: packageZip.length,
      },
    };
    const manifestZip = makeStoredZip({
      [PREPARED_NPM_MANIFEST]: JSON.stringify({
        schema: "openclaw.plugin-npm-prepared/v1",
        runtimeQualification: "packed-runtime-v1",
        sourceSha: source.params.sourceSha,
        npmDistTag: "default",
        selectionMode: "all-publishable",
        publisherPolicySha256: digest("name: immutable npm policy\n"),
        producer,
        packages: [entry],
      }),
    });
    Object.assign(source.params.artifact, {
      artifactDigest: "sha256:" + digest(manifestZip),
      artifactSizeBytes: manifestZip.length,
    });
    packageArchives.set(9001, manifestZip);
    packageArchives.set(9002, packageZip);
    source.archives.set(9001, manifestZip);
    source.artifacts.set(9001, {
      id: 9001,
      name: source.params.artifact.artifactName,
      digest: source.params.artifact.artifactDigest,
      size_in_bytes: manifestZip.length,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      created_at: "2026-08-28T12:01:02.000Z",
      workflow_run: { id: 101, head_sha: source.params.sourceSha, head_branch: source.f.branch },
    });
  });
  cliEnvironment(f, root);
  const fetch = f.paramsForLoad.fetchImpl;
  let afterDownload = () => {};
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const match = /actions\/artifacts\/(9001|9002)(\/zip)?$/u.exec(url.pathname);
    if (match) {
      const id = Number(match[1]);
      const bytes = packageArchives.get(id)!;
      if (match[2]) {
        afterDownload();
        return new Response(Uint8Array.from(bytes));
      }
      const artifact = id === 9001 ? f.params.artifact : entry.artifact;
      return Response.json({
        id,
        name: artifact.artifactName,
        digest: artifact.artifactDigest,
        size_in_bytes: bytes.length,
        expired: false,
        workflow_run: { id: 101, head_sha: f.params.sourceSha },
      });
    }
    if (url.pathname.endsWith("/runs/101/attempts/1")) {
      return Response.json({
        id: 101,
        run_attempt: 1,
        head_sha: f.params.sourceSha,
        head_branch: f.source.f.branch,
        path: ".github/workflows/plugin-npm-release.yml",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        repository: { full_name: f.params.repository },
        head_repository: { full_name: f.params.repository },
      });
    }
    return fetch(input);
  });
  const output = join(root, "outputs");
  const manifestOutput = join(root, "manifest.json");
  const evidenceOutput = join(root, "evidence.json");
  return {
    f,
    output,
    manifestOutput,
    evidenceOutput,
    setAfterDownload(callback: () => void) {
      afterDownload = callback;
    },
    args(command: string) {
      return [
        command,
        "--source-sha",
        f.params.sourceSha,
        "--selection-mode",
        "all-publishable",
        "--github-output",
        output,
        ...(command === "load"
          ? ["--source-root", root, "--output", manifestOutput, "--evidence-output", evidenceOutput]
          : [
              "--package",
              JSON.stringify(entry),
              "--source-package-json",
              packageJson,
              "--cache-dir",
              join(root, "cache"),
              "--output-dir",
              join(root, "consumed"),
            ]),
      ];
    },
  };
}

it.each(["load", "consume"])("keeps %s output behind the final fresh check", async (command) => {
  const f = await cliPackageFixture();
  await main(f.args(command));
  expect(readFileSync(f.output, "utf8")).toContain(
    command === "load" ? "has_candidates=true" : "tarball_sha256=",
  );
});

it.each(["permission", "tag", "frv-attempt", "carrier-attempt", "expiry"])(
  "refuses final authorize %s changes before granting authorization",
  async (fault) => {
    const f = await carrierFixture();
    cliEnvironment(f, tempDirs.make("npm-cli-revoke-"));
    const originalRead = transport.read;
    let childReads = 0;
    transport.read = (args) => {
      if (args[1]?.endsWith("/actions/runs/800") && ++childReads === 2) {
        if (fault === "permission") {
          f.source.f.admission.authority.permission = "read";
        }
        if (fault === "tag") {
          f.source.f.admission.authority.tagSha = "f".repeat(40);
        }
        if (fault === "frv-attempt") {
          f.source.f.parent.run_attempt += 1;
        }
        if (fault === "carrier-attempt") {
          f.run.run_attempt += 1;
        }
        if (fault === "expiry") {
          f.metadata.expired = true;
        }
      }
      return originalRead(args);
    };
    const authorized = vi.fn();
    await expect(
      main(["authorize", "--source-sha", f.params.sourceSha]).then(authorized),
    ).rejects.toThrow();
    expect(childReads).toBe(2);
    expect(authorized).not.toHaveBeenCalled();
  },
);

it.each(
  ["load", "consume"].flatMap((command) =>
    ["permission", "tag", "frv-attempt", "expiry"].map((fault) => [command, fault]),
  ),
)("rejects %s download-time %s changes before publishing outputs", async (command, fault) => {
  const f = await cliPackageFixture();
  const changed = vi.fn(() => {
    if (fault === "permission") {
      f.f.source.f.admission.authority.permission = "read";
    }
    if (fault === "tag") {
      f.f.source.f.admission.authority.tagSha = "f".repeat(40);
    }
    if (fault === "frv-attempt") {
      f.f.source.f.parent.run_attempt += 1;
    }
    if (fault === "expiry") {
      f.f.source.artifacts.get(91)!.expired = true;
    }
  });
  f.setAfterDownload(changed);
  await expect(main(f.args(command!))).rejects.toThrow();
  expect(changed).toHaveBeenCalledOnce();
  expect(existsSync(f.output)).toBe(false);
  expect(existsSync(f.manifestOutput)).toBe(false);
  expect(existsSync(f.evidenceOutput)).toBe(false);
});

it("still rejects a public call when authority changes after raw authentication", async () => {
  const f = await carrierFixture();
  const replay = await loadNpmEvidenceReplay(f.paramsForLoad);
  const revalidate = replay.revalidate.bind(replay);
  vi.spyOn(replay, "revalidate").mockImplementation(async (client) => {
    f.source.f.admission.authority.permission = "read";
    await revalidate(client);
  });
  await expect(
    authenticatePreparedNpmArtifact({ ...f.params, immutableReads: replay }),
  ).rejects.toThrow();
});
