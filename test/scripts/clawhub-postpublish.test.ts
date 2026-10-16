import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32 } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClawHubParentAuthorization,
  readPackedClawHubTransaction,
} from "../../scripts/clawhub-parent-authorization.mjs";
import { verifyClawHubPostpublish } from "../../scripts/clawhub-postpublish.mjs";
import {
  createPreparedClawHubManifest,
  downloadPreparedClawHubRelease,
  resolvePreparedClawHubMatrix,
  restorePreparedClawHubPackage,
} from "../../scripts/clawhub-prepared-artifact.mjs";
import { waitForClawHubPublicVersion } from "../../scripts/lib/clawhub-publication-state.mjs";
import { verifyPublishedClawHubPackage } from "../../scripts/verify-clawhub-published-artifact.mjs";

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const directories: string[] = [];
afterEach(() => vi.clearAllMocks());
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
const sha = "a".repeat(40);
const ref = `release-publish/${sha.slice(0, 12)}-1`;
const repository = "openclaw/openclaw";
const parentWorkflow = ".github/workflows/openclaw-release-publish.yml";
const childWorkflow = ".github/workflows/plugin-clawhub-release.yml";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function zip(name: string, bytes: Buffer) {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + bytes.length, 16);
  return Buffer.concat([local, fileName, bytes, central, fileName, end]);
}

function fixture(
  parentOnMain = false,
  verifierSha = sha,
  packageId = "example",
  parentRunAttempt = 1,
) {
  const parentRef = parentOnMain ? "main" : ref;
  const parentFullRef = parentOnMain ? "refs/heads/main" : `refs/tags/${ref}`;
  const directory = mkdtempSync(join(tmpdir(), "clawhub-postpublish-"));
  directories.push(directory);
  const packageDir = join(directory, "package");
  const artifactDir = join(directory, "artifact");
  mkdirSync(packageDir);
  mkdirSync(artifactDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: `@openclaw/${packageId}`, version: "2026.8.2" }),
  );
  writeFileSync(join(packageDir, "openclaw.plugin.json"), JSON.stringify({ id: packageId }));
  const tarballPath = join(artifactDir, `${packageId}.tgz`);
  tar.create(
    {
      sync: true,
      cwd: directory,
      file: tarballPath,
      gzip: true,
      portable: true,
      mtime: new Date("1985-10-26T08:15:00.000Z"),
      noPax: true,
    },
    ["package/package.json", "package/openclaw.plugin.json"],
  );
  const tarball = readFileSync(tarballPath);
  const entry = readPackedClawHubTransaction({
    artifactDir,
    packageName: `@openclaw/${packageId}`,
    version: "2026.8.2",
    artifactName: `package-${packageId}`,
  });
  const identity = {
    version: 2,
    repository,
    workflow: childWorkflow,
    runId: "20",
    runAttempt: "1",
    ref,
    fullRef: `refs/tags/${ref}`,
    sha,
    candidateRepository: repository,
    candidateSha: "b".repeat(40),
    toolingRef: parentRef,
    toolingFullRef: parentFullRef,
    toolingSha: sha,
    parentRepository: repository,
    parentWorkflow,
    parentRunId: "10",
    parentRunAttempt: String(parentRunAttempt),
  };
  const transactions = { schemaVersion: 1, identity, packages: [entry] };
  const receipt = createClawHubParentAuthorization(transactions, "automated-awaited");
  const run = (id: number, path: string) => ({
    id,
    run_attempt: id === 10 ? parentRunAttempt : 1,
    path: `${path}@${id === 10 ? parentFullRef : `refs/tags/${ref}`}`,
    head_sha: sha,
    head_branch: id === 10 ? parentRef : ref,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  });
  const parent = run(10, parentWorkflow);
  const child = run(20, childWorkflow);
  const archives = new Map<number, Buffer>();
  const artifact = (id: number, name: string, runId: number, fileName: string, bytes: Buffer) => {
    const archive = zip(fileName, bytes);
    archives.set(id, archive);
    return {
      id,
      name,
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      workflow_run: { id: runId, head_sha: sha },
    };
  };
  const receiptArtifact = artifact(
    1,
    `openclaw-clawhub-parent-authorization-v2-10-${parentRunAttempt}-20-1`,
    10,
    "authorization.json",
    Buffer.from(JSON.stringify(receipt)),
  );
  const transactionsArtifact = artifact(
    2,
    "openclaw-clawhub-transactions-20-1",
    20,
    "transactions.json",
    Buffer.from(JSON.stringify(transactions)),
  );
  const packageArtifact = artifact(3, `package-${packageId}`, 20, `${packageId}.tgz`, tarball);
  const recoveryManifest = {
    schemaVersion: 1,
    kind: "openclaw-clawhub-recovery-manifest",
    identity,
    packages: [{ ...entry, publicationStatus: "pending", attemptId: "attempt-1" }],
  };
  const recoveryArtifact = artifact(
    6,
    "openclaw-clawhub-recovery-manifest-20-1",
    20,
    "recovery-manifest.json",
    Buffer.from(JSON.stringify(recoveryManifest)),
  );
  const dispatch = {
    schemaVersion: 1,
    repository,
    parentRunId: "10",
    parentRunAttempt: String(parentRunAttempt),
    parentWorkflow,
    toolingRef: parentRef,
    toolingFullRef: parentFullRef,
    toolingSha: sha,
    candidateSha: identity.candidateSha,
    normalClawHubRunId: "20",
    normalClawHubRunAttempt: "1",
  };
  const dispatchArtifact = artifact(
    4,
    `openclaw-release-children-10-${parentRunAttempt}`,
    10,
    "dispatch.json",
    Buffer.from(JSON.stringify(dispatch)),
  );
  const metadata = new Map<string, unknown>([
    [`actions/runs/10/attempts/${parentRunAttempt}`, parent],
    ["actions/runs/20/attempts/1", child],
    ["actions/runs/20", child],
    [
      "actions/runs/10/artifacts?per_page=100&page=1",
      { total_count: 2, artifacts: [receiptArtifact, dispatchArtifact] },
    ],
    [
      "actions/runs/20/artifacts?per_page=100&page=1",
      { total_count: 3, artifacts: [transactionsArtifact, packageArtifact, recoveryArtifact] },
    ],
    [
      "actions/runs/20/artifacts?name=openclaw-clawhub-transactions-20-1&per_page=100",
      { total_count: 1, artifacts: [transactionsArtifact] },
    ],
    [
      "actions/runs/20/attempts/1/jobs?per_page=100&page=1",
      {
        total_count: 3,
        jobs: [
          {
            name: "Seal exact ClawHub recovery manifest",
            run_id: 20,
            run_attempt: 1,
            head_sha: sha,
            status: "completed",
            conclusion: "success",
            steps: [
              {
                name: "Upload sealed recovery manifest",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
          {
            name: "Seal ClawHub package transactions",
            run_id: 20,
            run_attempt: 1,
            head_sha: sha,
            status: "completed",
            conclusion: "success",
          },
          {
            name: `Pack ClawHub package (${entry.name})`,
            run_id: 20,
            run_attempt: 1,
            head_sha: sha,
            status: "completed",
            conclusion: "success",
            steps: [
              {
                name: "Upload ClawHub package artifact",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        ],
      },
    ],
    [`git/ref/tags/${ref}`, { ref: `refs/tags/${ref}`, object: { type: "commit", sha } }],
    [`git/matching-refs/heads/${ref}`, []],
    [`compare/${sha}...main`, { status: "identical" }],
    [`compare/${sha}...${verifierSha}`, { status: "identical" }],
    [`compare/${sha}...${verifierSha}?per_page=1&page=2`, { status: "identical" }],
    ...[
      receiptArtifact,
      transactionsArtifact,
      packageArtifact,
      dispatchArtifact,
      recoveryArtifact,
    ].map((item): [string, unknown] => [`actions/artifacts/${item.id}`, item]),
  ]);
  const githubReads: string[] = [];
  const registryReads: string[] = [];
  const archiveIdentity = {
    sha256: digest(tarball),
    size: tarball.length,
    npmIntegrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    npmShasum: createHash("sha1").update(tarball).digest("hex"),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
    expect(init?.method ?? "GET").toBe("GET");
    if (url.hostname === "api.github.com") {
      const path = `${url.pathname.replace(`/repos/${repository}/`, "")}${url.search}`;
      githubReads.push(path);
      const download = /^actions\/artifacts\/(\d+)\/zip$/u.exec(path);
      if (download) {
        return new Response(new Uint8Array(archives.get(Number(download[1]))!));
      }
      if (!metadata.has(path)) {
        throw new Error(`Unexpected GitHub request: ${path}`);
      }
      const value = metadata.get(path);
      return value instanceof Response ? value : Response.json(value);
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    registryReads.push(url.pathname);
    if (url.pathname.endsWith("/publication")) {
      return Response.json({ name: entry.name, version: entry.version, state: "published" });
    }
    if (url.pathname.endsWith("/trusted-publisher")) {
      return Response.json({
        trustedPublisher: {
          provider: "github-actions",
          repository,
          workflowFilename: "plugin-clawhub-release.yml",
        },
      });
    }
    if (url.pathname.endsWith("/artifact/download")) {
      return new Response(new Uint8Array(tarball), {
        headers: {
          "x-clawhub-artifact-sha256": archiveIdentity.sha256,
          "x-clawhub-npm-integrity": archiveIdentity.npmIntegrity,
          "x-clawhub-npm-shasum": archiveIdentity.npmShasum,
        },
      });
    }
    if (url.pathname.endsWith("/artifact")) {
      return Response.json({
        package: { name: entry.name },
        version: entry.version,
        artifact: { kind: "npm-pack", ...archiveIdentity },
      });
    }
    return Response.json({ package: { tags: { latest: entry.version } } });
  };
  const options = {
    event: { workflow_run: parent },
    verifierSha,
    token: "fixture-token",
    outputDir: join(directory, "result"),
    fetchImpl,
    runGh: (args: string[]) => {
      const apiPath = args[1];
      if (apiPath === undefined) {
        throw new Error("Missing GitHub API path.");
      }
      const key = apiPath.replace(`repos/${repository}/`, "");
      if (!metadata.has(key)) {
        throw new Error(`Unexpected gh request: ${key}`);
      }
      return JSON.stringify(metadata.get(key));
    },
  };
  return {
    directory,
    tarball,
    packageArtifact,
    options,
    parent,
    child,
    metadata,
    archives,
    githubReads,
    registryReads,
    transactions,
    entry,
    receiptArtifact,
    dispatch,
    dispatchArtifact,
    receipt,
  };
}

function retryFixture({
  parentOnMain = false,
  producerAttempt = 1,
  terminalAttempt = producerAttempt + 1,
  jobName = "Publish plugins, then OpenClaw",
}: {
  parentOnMain?: boolean;
  producerAttempt?: number;
  terminalAttempt?: number;
  jobName?: string;
} = {}) {
  const f = fixture(parentOnMain, sha, "example", producerAttempt);
  f.metadata.set(`actions/runs/10/attempts/${producerAttempt}`, {
    ...f.parent,
    conclusion: "failure",
  });
  f.parent.run_attempt = terminalAttempt;
  f.metadata.set(`actions/runs/10/attempts/${terminalAttempt}`, f.parent);
  const uploadStep = {
    name: "Upload exact release child dispatch record",
    status: "completed",
    conclusion: "success",
    number: 23,
    started_at: "2026-10-05T18:48:31Z",
    completed_at: "2026-10-05T18:48:32Z",
  };
  const producer = {
    run_id: 10,
    run_attempt: producerAttempt,
    head_sha: sha,
    name: jobName,
    status: "completed",
    conclusion: "success",
    runner_id: 42,
    started_at: "2026-10-05T18:43:49Z",
    completed_at: "2026-10-05T19:10:19Z",
    steps: [uploadStep],
  };
  const originalProducer = { ...producer, steps: [{ ...uploadStep }] };
  const terminalUpload = { ...uploadStep };
  const terminalProducer = { ...producer, run_attempt: terminalAttempt, steps: [terminalUpload] };
  for (const job of [originalProducer, terminalProducer]) {
    f.metadata.set(`actions/runs/10/attempts/${job.run_attempt}/jobs?per_page=100&page=1`, {
      total_count: 1,
      jobs: [job],
    });
  }
  return { ...f, originalProducer, terminalProducer, terminalUpload };
}

function preparedFixture(selectionMode = "selected", packageId = "example", runAttempt = 1) {
  const f = fixture(false, sha, packageId);
  const candidateSha = f.transactions.identity.candidateSha;
  const producer = {
    repository,
    runId: 20,
    runAttempt,
    workflowPath: childWorkflow,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: ref,
    workflowSha: sha,
  };
  f.child.run_attempt = runAttempt;
  f.metadata.set(`actions/runs/20/attempts/${runAttempt}`, f.child);
  const packageArtifact = {
    ...f.packageArtifact,
    name: `clawhub-package-openclaw-${packageId}-${f.entry.version}-20-${runAttempt}`,
  };
  f.metadata.set("actions/artifacts/3", packageArtifact);
  const matrix = [
    {
      packageName: f.entry.name,
      packageDir: `extensions/${packageId}`,
      version: f.entry.version,
      publishTag: "latest",
      artifactName: packageArtifact.name,
      alreadyPublished: false,
    },
  ] as const;
  const packedDirectory = join(f.directory, "prepared-packages");
  mkdirSync(join(packedDirectory, packageArtifact.name), { recursive: true });
  writeFileSync(join(packedDirectory, packageArtifact.name, `${packageId}.tgz`), f.tarball);
  const packJob = {
    name: `Pack ClawHub package (${f.entry.name})`,
    run_id: 20,
    run_attempt: runAttempt,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
  const sealOptions = {
    candidateSha,
    producer,
    selectionMode,
    matrix,
    directory: packedDirectory,
    artifacts: [packageArtifact] as const,
    workflowRun: { ...f.child, status: "in_progress", conclusion: null },
    workflowJobs: {
      total_count: 1,
      jobs: [packJob] as const,
    },
  };
  const manifest = createPreparedClawHubManifest(sealOptions);
  const manifestName = `clawhub-prepared-${candidateSha.slice(0, 12)}-20-${runAttempt}`;
  const archive = zip("prepared-clawhub.json", Buffer.from(JSON.stringify(manifest)));
  f.archives.set(5, archive);
  const descriptor = {
    ...producer,
    artifactId: 5,
    artifactName: manifestName,
    artifactDigest: `sha256:${digest(archive)}`,
    artifactSizeBytes: archive.length,
  };
  f.metadata.set("actions/artifacts/5", {
    id: 5,
    name: manifestName,
    digest: descriptor.artifactDigest,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: 20, head_sha: sha },
  });
  const runGhJson = (apiPath: string) => {
    if (!f.metadata.has(apiPath)) {
      throw new Error(`Unexpected GitHub request: ${apiPath}`);
    }
    return f.metadata.get(apiPath);
  };
  const resolveOptions = {
    descriptor,
    candidateSha,
    toolingSha: sha,
    selectionMode,
    plugins: selectionMode === "all-publishable" ? [] : [f.entry.name],
    token: f.options.token,
    fetchImpl: f.options.fetchImpl,
    runGhJson,
  };
  const restoreOptions = {
    descriptor,
    toolingSha: sha,
    entry: manifest.packages[0],
    outputDir: join(f.directory, "promoted-package"),
    token: f.options.token,
    fetchImpl: f.options.fetchImpl,
    runGhJson,
  };
  return { ...f, manifest, resolveOptions, restoreOptions, sealOptions };
}

function preparedSealingFixture(attempts: readonly [number, number] = [2, 2]) {
  const first = preparedFixture("all-publishable", "example", attempts[0]);
  const second = preparedFixture("all-publishable", "other", attempts[1]);
  const [secondEntry] = second.sealOptions.matrix;
  const secondDirectory = join(first.sealOptions.directory, secondEntry.artifactName);
  mkdirSync(secondDirectory);
  writeFileSync(join(secondDirectory, "other.tgz"), second.tarball);
  return {
    ...first.sealOptions,
    producer: { ...first.sealOptions.producer, runAttempt: 2 },
    workflowRun: { ...first.sealOptions.workflowRun, run_attempt: 2 },
    matrix: [...first.sealOptions.matrix, secondEntry] as const,
    artifacts: [
      ...first.sealOptions.artifacts,
      { ...second.sealOptions.artifacts[0], id: 6 },
    ] as const,
    workflowJobs: {
      total_count: 2,
      jobs: [
        ...first.sealOptions.workflowJobs.jobs,
        ...second.sealOptions.workflowJobs.jobs,
      ] as const,
    },
  };
}

it.each([{ version: "2026.8.2-alpha.1" }, { publishTag: "alpha" }])(
  "rejects retired alpha prepared selection %j",
  (override) => {
    const f = preparedFixture();
    expect(() =>
      createPreparedClawHubManifest({
        ...f.sealOptions,
        matrix: [{ ...f.sealOptions.matrix[0], ...override }],
      }),
    ).toThrow("Alpha releases are retired;");
  },
);

describe("ClawHub prepared publication", () => {
  it("seals a lone prepared package from a flat artifact download", () => {
    const f = preparedFixture();
    const { directory, matrix } = f.sealOptions;
    rmSync(join(directory, matrix[0].artifactName), { recursive: true });
    writeFileSync(join(directory, "example.tgz"), f.tarball);

    const manifest = createPreparedClawHubManifest(f.sealOptions);
    expect(manifest.packages).toMatchObject([
      {
        packageName: "@openclaw/example",
        version: "2026.8.2",
        tarballName: "example.tgz",
        tarballSha256: digest(f.tarball),
        tarballSizeBytes: f.tarball.length,
      },
    ]);
  });

  it("seals the complete same-attempt roster from successful pack producers", () => {
    const options = preparedSealingFixture();
    const manifest = createPreparedClawHubManifest(options);
    expect(manifest.packages.map((entry: { packageName: string }) => entry.packageName)).toEqual([
      "@openclaw/example",
      "@openclaw/other",
    ]);
    expect(manifest.producer.runAttempt).toBe(2);
    for (const entry of manifest.packages) {
      const transaction = readPackedClawHubTransaction({
        artifactDir: join(options.directory, entry.artifactName),
        packageName: entry.packageName,
        version: entry.version,
        artifactName: entry.artifactName,
      });
      expect(entry.tarballSha256).toBe(transaction.artifactSha256);
      expect(entry.inventoryDigest).toBe(transaction.inventoryDigest);
    }
  });

  it.each(["prior attempt", "mixed attempt", "failed producer", "reused producer"])(
    "refuses to relabel %s packages as the current preparation attempt",
    (change) => {
      const options = preparedSealingFixture(
        change === "prior attempt" ? [1, 1] : change === "mixed attempt" ? [1, 2] : [2, 2],
      );
      if (change === "failed producer") {
        options.workflowJobs.jobs[0].conclusion = "failure";
      }
      if (change === "reused producer") {
        options.workflowJobs.jobs[0].run_attempt = 1;
      }
      expect(() => createPreparedClawHubManifest(options)).toThrow(
        /producer attempt|producer job did not complete successfully/u,
      );
    },
  );

  it("seals an empty roster without requiring a skipped pack job", () => {
    const f = preparedFixture("all-publishable");
    expect(
      createPreparedClawHubManifest({
        ...f.sealOptions,
        matrix: [],
        artifacts: [],
        workflowJobs: { total_count: 0, jobs: [] },
      }).packages,
    ).toEqual([]);
  });

  it.each(["selected", "all-publishable"])(
    "retains the %s prepared roster when an exact version is adopted on resume",
    async (selectionMode) => {
      const f = preparedFixture(selectionMode);
      const [entry] = await resolvePreparedClawHubMatrix(f.resolveOptions);
      expect(entry.alreadyPublished).toBe(true);
      await restorePreparedClawHubPackage({ ...f.restoreOptions, entry: entry.prepared });
      expect(readFileSync(join(f.restoreOptions.outputDir, "example.tgz"))).toEqual(f.tarball);
      const readback = await verifyPublishedClawHubPackage({
        expectedArtifactDir: f.restoreOptions.outputDir,
        packageName: entry.packageName,
        packageVersion: entry.version,
        publishTag: entry.publishTag,
        retryOptions: { fetchImpl: f.options.fetchImpl, attempts: 1 },
      });
      expect(readback.package.registrySha256).toBe(f.entry.artifactSha256);
      expect(readback.publicationAuthentication).toBe("not-verified");
    },
  );

  it("restores established package families in prepared promotion matrices", async () => {
    const f = preparedFixture("selected", "cloudflare");
    const [entry] = await resolvePreparedClawHubMatrix(f.resolveOptions);
    expect(entry.family).toBe("bundle-plugin");
  });

  it.each([
    { publication: { state: "published" } },
    { publication: { state: "absent" } },
    { publication: { state: "pending", stage: "staging" } },
    { publication: { state: "pending", stage: "checks", attemptId: "attempt_checks" } },
    { publication: { state: "failed", attemptId: "attempt_recover", recoverable: true } },
    { publication: { state: "failed", recoverable: false } },
    { publication: { state: "published" }, legacy: [404, 200] },
    { publication: { state: "absent" }, legacy: [200, 404] },
  ])("resolves prepared publication detail: %j", async ({ publication, legacy }) => {
    const f = preparedFixture();
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.includes("/versions/")) {
        requests.push(url.slice(url.indexOf("/versions/")));
        if (url.endsWith("/publication")) {
          return Response.json(
            { name: f.entry.name, version: f.entry.version, ...(legacy ? {} : publication) },
            { status: legacy?.[0] ?? 200 },
          );
        }
        if (!legacy) {
          throw new Error("Recognized publication state must not fall back to the version probe.");
        }
        return new Response(null, { status: legacy[1] });
      }
      if (url.endsWith("/trusted-publisher") && ["pending", "failed"].includes(publication.state)) {
        return new Response(null, { status: 404 });
      }
      return f.options.fetchImpl(input, init);
    };
    const [entry] = await resolvePreparedClawHubMatrix({ ...f.resolveOptions, fetchImpl });
    expect(entry).toMatchObject({
      packageName: f.entry.name,
      publication,
      alreadyPublished: publication.state === "published",
      prepared: { tarballSha256: f.entry.artifactSha256 },
    });
    expect(entry.publication).toEqual(publication);
    expect(requests).toEqual([
      `/versions/${f.entry.version}/publication`,
      ...(legacy ? [`/versions/${f.entry.version}`] : []),
    ]);
  });

  it.each([
    { label: "missing package", status: 404, patch: {} },
    { label: "missing configuration", status: 200, patch: null },
    { label: "wrong provider", status: 200, patch: { provider: "other" } },
    { label: "wrong repository", status: 200, patch: { repository: "other/repository" } },
    { label: "wrong workflow", status: 200, patch: { workflowFilename: "other-release.yml" } },
    { label: "unexpected environment", status: 200, patch: { environment: "production" } },
  ])(
    "requires existing owner repair for $label before normal preparation",
    async ({ status, patch }) => {
      const f = preparedFixture("all-publishable");
      const registryRequests: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = requestUrl(input);
        if (url.startsWith("https://clawhub.ai/")) {
          registryRequests.push(url);
        }
        if (url.endsWith("/trusted-publisher")) {
          if (status === 404) {
            return new Response(null, { status });
          }
          const response = await f.options.fetchImpl(input, init);
          const body: {
            trustedPublisher: { provider: string; repository: string; workflowFilename: string };
          } = await response.json();
          return Response.json({
            trustedPublisher: patch === null ? null : { ...body.trustedPublisher, ...patch },
          });
        }
        return f.options.fetchImpl(input, init);
      };
      await expect(
        resolvePreparedClawHubMatrix({ ...f.resolveOptions, fetchImpl }),
      ).rejects.toThrow(/Plugin ClawHub New owner before preparing again/u);
      expect(registryRequests).toEqual([
        `https://clawhub.ai/api/v1/packages/${encodeURIComponent(f.entry.name)}/versions/${f.entry.version}/publication`,
        `https://clawhub.ai/api/v1/packages/${encodeURIComponent(f.entry.name)}/trusted-publisher`,
      ]);
    },
  );

  it("reuses a verified saved archive and output, but refuses to overwrite changed bytes", async () => {
    const f = preparedFixture();
    const options = { ...f.restoreOptions, archivePath: join(f.directory, "package.zip") };
    await restorePreparedClawHubPackage(options);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestUrl(input).endsWith("/zip")) {
        throw new Error("Saved verified bytes must not be redownloaded.");
      }
      return f.options.fetchImpl(input, init);
    };
    await restorePreparedClawHubPackage({ ...options, fetchImpl });
    const tarballPath = join(options.outputDir, "example.tgz");
    writeFileSync(tarballPath, "changed local bytes");
    await expect(restorePreparedClawHubPackage({ ...options, fetchImpl })).rejects.toThrow();
    expect(readFileSync(tarballPath, "utf8")).toBe("changed local bytes");
  });

  it.each(["extra", "all-publishable"])(
    "rejects %s drift instead of silently publishing a different roster",
    async (change) => {
      const f = preparedFixture();
      const plugins = change === "extra" ? [f.entry.name, "@openclaw/other"] : [];
      await expect(
        downloadPreparedClawHubRelease({
          ...f.resolveOptions,
          plugins,
          selectionMode: change === "all-publishable" ? "all-publishable" : "selected",
        }),
      ).rejects.toThrow(/selection.*mismatch/u);
      expect(f.registryReads).toEqual([]);
    },
  );

  it.each(["candidate", "tooling", "producer-attempt", "producer-ref"])(
    "rejects substituted %s before exposing publication bytes",
    async (change) => {
      const f = preparedFixture();
      if (change === "producer-attempt") {
        f.child.run_attempt = 2;
      }
      if (change === "producer-ref") {
        f.child.path = `${childWorkflow}@refs/heads/${ref}`;
      }
      await expect(
        downloadPreparedClawHubRelease({
          ...f.resolveOptions,
          ...(change === "candidate" ? { candidateSha: "c".repeat(40) } : {}),
          ...(change === "tooling" ? { toolingSha: "c".repeat(40) } : {}),
        }),
      ).rejects.toThrow(/(mismatch|immutable publication tuple)/u);
      expect(existsSync(f.restoreOptions.outputDir)).toBe(false);
    },
  );

  it("retries an interrupted body against the same artifact and restores its original bytes", async () => {
    const f = preparedFixture();
    let transfers = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestUrl(input).endsWith("/actions/artifacts/3/zip") && ++transfers === 1) {
        let firstChunk = true;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (firstChunk) {
                firstChunk = false;
                controller.enqueue(new Uint8Array(f.archives.get(3)!.subarray(0, 31)));
              } else {
                controller.error(
                  new TypeError("terminated", {
                    cause: Object.assign(new Error("other side closed"), {
                      code: "UND_ERR_SOCKET",
                    }),
                  }),
                );
              }
            },
          }),
        );
      }
      return f.options.fetchImpl(input, init);
    };
    await restorePreparedClawHubPackage({ ...f.restoreOptions, fetchImpl });
    expect(transfers).toBe(2);
    expect(readFileSync(join(f.restoreOptions.outputDir, "example.tgz"))).toEqual(f.tarball);
  });

  it("leaves no publishable output when a retained tarball inventory conflicts", async () => {
    const f = preparedFixture();
    const entry = { ...f.restoreOptions.entry, inventoryDigest: "f".repeat(64) };
    await expect(
      restorePreparedClawHubPackage({
        ...f.restoreOptions,
        entry,
      }),
    ).rejects.toThrow(/bytes and inventory mismatch/u);
    expect(existsSync(f.restoreOptions.outputDir)).toBe(false);
    expect(f.registryReads).toEqual([]);
  });

  it("refuses a matching-version registry package with different bytes instead of adopting it", async () => {
    const f = preparedFixture();
    await restorePreparedClawHubPackage(f.restoreOptions);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestUrl(input).endsWith("/artifact/download")) {
        return new Response("different published bytes");
      }
      return f.options.fetchImpl(input, init);
    };
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: f.restoreOptions.outputDir,
        packageName: f.entry.name,
        packageVersion: f.entry.version,
        publishTag: "latest",
        retryOptions: { fetchImpl, attempts: 1 },
      }),
    ).rejects.toThrow(/registry artifact sha256 mismatch/u);
  });
});

describe("ClawHub detached postpublish verification", () => {
  it.each([
    { label: "protected-tag publication", noChild: false },
    { label: "main publication", noChild: false, parentOnMain: true },
    { label: "no normal ClawHub child", noChild: true },
    { label: "Docker-only recovery", noChild: true, jobName: "record_docker_only_scope" },
  ])(
    "reuses the retained dispatch producer after a terminal retry: $label",
    async ({ noChild, ...options }) => {
      const f = retryFixture(options);
      if (noChild) {
        const archive = zip(
          "dispatch.json",
          Buffer.from(
            JSON.stringify({
              ...f.dispatch,
              normalClawHubRunId: null,
              normalClawHubRunAttempt: null,
            }),
          ),
        );
        f.archives.set(4, archive);
        Object.assign(f.dispatchArtifact, {
          size_in_bytes: archive.length,
          digest: `sha256:${digest(archive)}`,
        });
      }
      const result = await verifyClawHubPostpublish(f.options);
      expect(result).toMatchObject({ complete: true, parentRunAttempt: 2, dispatchRunAttempt: 1 });
      expect(result.packages).toHaveLength(noChild ? 0 : 1);
      expect(f.registryReads.length > 0).toBe(!noChild);
    },
  );

  it("selects the retained producer among distinct historical dispatches", async () => {
    const f = retryFixture({ producerAttempt: 2 });
    const oldRun = { ...f.parent, run_attempt: 1, conclusion: "failure" };
    const oldJob = { ...structuredClone(f.originalProducer), run_attempt: 1, runner_id: 7 };
    f.metadata.set("actions/runs/10/attempts/1", oldRun);
    f.metadata.set("actions/runs/10/attempts/1/jobs?per_page=100&page=1", {
      total_count: 1,
      jobs: [oldJob],
    });
    const oldArchive = zip(
      "dispatch.json",
      Buffer.from(
        JSON.stringify({ ...f.dispatch, parentRunAttempt: "1", normalClawHubRunId: "19" }),
      ),
    );
    const oldArtifact = {
      ...f.dispatchArtifact,
      id: 5,
      name: "openclaw-release-children-10-1",
      size_in_bytes: oldArchive.length,
      digest: `sha256:${digest(oldArchive)}`,
    };
    f.archives.set(5, oldArchive);
    f.metadata.set("actions/artifacts/5", oldArtifact);
    f.metadata.set("actions/runs/10/artifacts?per_page=100&page=1", {
      total_count: 3,
      artifacts: [oldArtifact, f.receiptArtifact, f.dispatchArtifact],
    });
    expect(await verifyClawHubPostpublish(f.options)).toMatchObject({
      complete: true,
      parentRunAttempt: 3,
      dispatchRunAttempt: 2,
      dispatchArtifactId: 4,
    });
    expect(f.registryReads.length).toBeGreaterThan(0);
  });

  it.each([
    { change: "rerun producer", error: /retained ClawHub dispatch record/u },
    { change: "different runner", error: /retained ClawHub dispatch record/u },
    { change: "failed producer", error: /successful ClawHub dispatch producer/u },
    { change: "future record", error: /retained ClawHub dispatch record/u },
    { change: "ambiguous records", error: /ambiguous retained/u },
    { change: "changed digest", error: /digest/u },
    { change: "changed source", error: /headSha mismatch/u },
    { change: "changed ref", error: /producer workflow ref mismatch/u },
    { change: "parallel producer", error: /ambiguous successful ClawHub dispatch producer/u },
    { change: "excessive history", error: /historical record limit/u },
  ])(
    "rejects $change during retained dispatch recovery before registry reads",
    async ({ change, error }) => {
      const f = retryFixture();
      if (change === "rerun producer") {
        f.terminalProducer.started_at = "2026-10-05T20:00:00Z";
        f.terminalProducer.completed_at = "2026-10-05T20:10:00Z";
        f.terminalUpload.started_at = "2026-10-05T20:05:00Z";
        f.terminalUpload.completed_at = "2026-10-05T20:05:01Z";
      } else if (change === "different runner") {
        f.originalProducer.runner_id = 43;
      } else if (change === "failed producer") {
        f.originalProducer.conclusion = "failure";
      } else if (change === "future record") {
        f.dispatchArtifact.name = "openclaw-release-children-10-3";
      } else if (change === "ambiguous records") {
        f.metadata.set("actions/runs/10/artifacts?per_page=100&page=1", {
          total_count: 3,
          artifacts: [f.receiptArtifact, f.dispatchArtifact, { ...f.dispatchArtifact, id: 5 }],
        });
      } else if (change === "changed digest") {
        const changed = Buffer.from(f.archives.get(4)!);
        changed.writeUInt32LE(0, 0);
        f.archives.set(4, changed);
      } else if (change === "changed ref") {
        f.metadata.set("actions/runs/10/attempts/1", {
          ...f.parent,
          run_attempt: 1,
          path: `${parentWorkflow}@refs/heads/main`,
        });
      } else if (change === "parallel producer") {
        f.metadata.set("actions/runs/10/attempts/2/jobs?per_page=100&page=1", {
          total_count: 2,
          jobs: [f.terminalProducer, { ...f.terminalProducer, runner_id: 7 }],
        });
      } else if (change === "excessive history") {
        f.metadata.set("actions/runs/10/artifacts?per_page=100&page=1", {
          total_count: 33,
          artifacts: Array.from({ length: 33 }, (_, index) => ({
            ...f.dispatchArtifact,
            id: index + 4,
          })),
        });
      } else {
        f.metadata.set("actions/runs/10/attempts/1", {
          ...f.parent,
          run_attempt: 1,
          head_sha: "c".repeat(40),
        });
      }
      await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(error);
      expect(f.registryReads).toEqual([]);
      expect(existsSync(join(f.options.outputDir, "evidence.json"))).toBe(false);
    },
  );

  it.each([
    {
      label: "sealed milestone while the parent remains active",
      status: "in_progress",
      conclusion: null,
      parentStatePolicy: "sealed-producer",
      childConclusion: "success",
      parentJobConclusion: "success",
    },
    {
      label: "sealed milestone after parent and child failure",
      status: "completed",
      conclusion: "failure",
      parentStatePolicy: "sealed-producer",
      childConclusion: "failure",
      parentJobConclusion: "success",
    },
    {
      label: "sealed milestone after parent success",
      status: "completed",
      conclusion: "success",
      parentStatePolicy: "sealed-producer",
      childConclusion: "success",
      parentJobConclusion: "success",
    },
    {
      label: "protected recovery after parent cancellation",
      status: "completed",
      conclusion: "cancelled",
      parentStatePolicy: "recovery-producer",
      childConclusion: "success",
      parentJobConclusion: "cancelled",
    },
  ])("reconciles the complete roster from $label", async (parentState) => {
    const f = fixture();
    const parent = {
      ...f.parent,
      status: parentState.status,
      conclusion: parentState.conclusion,
    };
    f.metadata.set("actions/runs/10/attempts/1", parent);
    f.child.conclusion = parentState.childConclusion;
    const receipt = createClawHubParentAuthorization(f.transactions, "automated-sealed");
    const receiptArchive = zip("authorization.json", Buffer.from(JSON.stringify(receipt)));
    f.archives.set(1, receiptArchive);
    Object.assign(f.receiptArtifact, {
      size_in_bytes: receiptArchive.length,
      digest: `sha256:${digest(receiptArchive)}`,
    });
    f.metadata.set("actions/runs/10/attempts/1/jobs?per_page=100&page=1", {
      total_count: 1,
      jobs: [
        {
          name: "Publish plugins, then OpenClaw",
          run_id: 10,
          run_attempt: 1,
          head_sha: sha,
          status: "completed",
          conclusion: parentState.parentJobConclusion,
          steps: [
            {
              name: "Upload exact release child dispatch record",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "Upload immutable ClawHub parent authorization",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ],
    });

    const recoveryManifest = {
      schemaVersion: 1,
      kind: "openclaw-clawhub-recovery-manifest",
      identity: f.transactions.identity,
      packages: f.transactions.packages.map((entry) => ({
        ...entry,
        publicationStatus: "pending",
        attemptId: "attempt-1",
      })),
    };
    if (parentState.parentStatePolicy === "recovery-producer") {
      const authorized = await verifyClawHubPostpublish({
        ...f.options,
        parent,
        parentStatePolicy: parentState.parentStatePolicy,
        recoveryManifest,
        verifyPublication: false,
      });
      expect(authorized).toMatchObject({
        complete: true,
        outcome: "authorized-recovery-roster",
      });
      expect(f.registryReads).toEqual([]);
    }

    const result = await verifyClawHubPostpublish({
      ...f.options,
      parent,
      parentStatePolicy: parentState.parentStatePolicy,
      recoveryManifest:
        parentState.parentStatePolicy === "recovery-producer" ? recoveryManifest : undefined,
    });
    expect(result.complete).toBe(true);
    expect(result.packages).toHaveLength(1);
    f.metadata.set("actions/runs/20/artifacts?per_page=100&page=1", {
      total_count: 2,
      artifacts: [f.metadata.get("actions/artifacts/2"), f.packageArtifact],
    });
    await expect(
      verifyClawHubPostpublish({
        ...f.options,
        parent,
        parentStatePolicy: parentState.parentStatePolicy,
      }),
    ).rejects.toThrow(/sealed ClawHub original attempt roster/u);
  });

  it("verifies historical successful publishers without recovery manifests", async () => {
    const f = fixture();
    f.metadata.set("actions/runs/20/artifacts?per_page=100&page=1", {
      total_count: 2,
      artifacts: [f.metadata.get("actions/artifacts/2"), f.packageArtifact],
    });
    expect(await verifyClawHubPostpublish(f.options)).toMatchObject({
      complete: true,
      packages: [expect.objectContaining({ inventoryDigest: f.entry.inventoryDigest })],
    });
    expect(f.registryReads.length).toBeGreaterThan(0);
    expect(f.registryReads.some((url) => url.endsWith("/publication"))).toBe(false);
    await expect(
      verifyClawHubPostpublish({ ...f.options, verifyPublication: false }),
    ).rejects.toThrow(/sealed ClawHub original attempt roster/u);
  });

  it.each(["published", "failed", "replacement"])(
    "waits on the sealed original attempt before public readback: %s",
    async (outcome) => {
      const f = fixture();
      let publicationReads = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        if (requestUrl(input).endsWith("/publication")) {
          publicationReads += 1;
          const state =
            publicationReads === 1
              ? { state: "pending", stage: "finalization", attemptId: "attempt-1" }
              : outcome === "published"
                ? { state: "published" }
                : outcome === "failed"
                  ? { state: "failed", recoverable: false, attemptId: "attempt-1" }
                  : { state: "pending", stage: "checks", attemptId: "replacement" };
          return Response.json({ name: f.entry.name, version: f.entry.version, ...state });
        }
        if (
          requestUrl(input).endsWith(encodeURIComponent(f.entry.name)) &&
          !(publicationReads === 2 && outcome === "published")
        ) {
          return Response.json({ package: { tags: { latest: "2026.8.1" } } });
        }
        return f.options.fetchImpl(input, init);
      };
      const options = { ...f.options, fetchImpl };
      if (outcome === "published") {
        expect((await verifyClawHubPostpublish(options)).complete).toBe(true);
        expect(f.registryReads.length).toBeGreaterThan(0);
      } else {
        await expect(verifyClawHubPostpublish(options)).rejects.toThrow(
          outcome === "failed" ? /publication failed/u : /sealed attempt/u,
        );
        expect(f.registryReads).toEqual([]);
        expect(
          JSON.parse(readFileSync(join(options.outputDir, "evidence.json"), "utf8")),
        ).toMatchObject({
          complete: false,
        });
      }
      expect(publicationReads).toBe(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000);
    },
  );

  it.each(["published", "pending"])(
    "reads authoritative completion after an earlier batch exhausts the wait budget: %s",
    async (state) => {
      const entry = { name: "@openclaw/example", version: "2026.8.2", attemptId: "attempt-1" };
      const publication =
        state === "published"
          ? { state }
          : { state, stage: "finalization", attemptId: entry.attemptId };
      const fetchImpl = vi.fn(async () =>
        Response.json({
          name: entry.name,
          version: entry.version,
          ...publication,
        }),
      );
      const onState = vi.fn();
      const observation = waitForClawHubPublicVersion(entry, {
        deadline: Date.now() - 1,
        fetchImpl,
        onState,
      });
      if (state === "published") {
        await expect(observation).resolves.toBeUndefined();
      } else {
        await expect(observation).rejects.toThrow(
          /attempt attempt-1.*Retry postpublish verification/u,
        );
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenCalledWith(publication);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("finds exact package producers beyond the first job page", async () => {
    const f = fixture();
    const parent = { ...f.parent, status: "completed", conclusion: "failure" };
    f.metadata.set("actions/runs/10/attempts/1", parent);
    const receipt = createClawHubParentAuthorization(f.transactions, "automated-sealed");
    const receiptArchive = zip("authorization.json", Buffer.from(JSON.stringify(receipt)));
    f.archives.set(1, receiptArchive);
    Object.assign(f.receiptArtifact, {
      size_in_bytes: receiptArchive.length,
      digest: `sha256:${digest(receiptArchive)}`,
    });
    f.metadata.set("actions/runs/10/attempts/1/jobs?per_page=100&page=1", {
      total_count: 1,
      jobs: [
        {
          name: "Publish plugins, then OpenClaw",
          run_id: 10,
          run_attempt: 1,
          head_sha: sha,
          status: "completed",
          conclusion: "success",
          steps: [
            {
              name: "Upload exact release child dispatch record",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "Upload immutable ClawHub parent authorization",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ],
    });
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `Unrelated job ${index}`,
      run_id: 20,
      run_attempt: 1,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    }));
    const original = f.metadata.get("actions/runs/20/attempts/1/jobs?per_page=100&page=1") as {
      jobs: unknown[];
    };
    f.metadata.set("actions/runs/20/attempts/1/jobs?per_page=100&page=1", {
      total_count: 103,
      jobs: firstPage,
    });
    f.metadata.set("actions/runs/20/attempts/1/jobs?per_page=100&page=2", {
      total_count: 103,
      jobs: original.jobs,
    });
    const result = await verifyClawHubPostpublish({
      ...f.options,
      parent,
      parentStatePolicy: "sealed-producer",
    });
    expect(result.complete).toBe(true);
    expect(
      f.githubReads.filter((path) => path.includes("actions/runs/20/attempts/1/jobs")),
    ).toEqual([
      "actions/runs/20/attempts/1/jobs?per_page=100&page=1",
      "actions/runs/20/attempts/1/jobs?per_page=100&page=2",
    ]);
  });

  it.each([
    { label: "protected-tag parent", parentOnMain: false, status: "identical" },
    { label: "main parent and protected-tag child", parentOnMain: true, status: "ahead" },
  ])(
    "reads authorized bytes using bounded ancestry without commits for $label",
    async ({ parentOnMain, status }) => {
      const verifierSha = status === "identical" ? sha : "c".repeat(40);
      const f = fixture(parentOnMain, verifierSha);
      const comparison = `compare/${sha}...${verifierSha}`;
      f.metadata.set(comparison, {
        status,
        files: [{ filename: "large.txt", patch: "+change\n".repeat(300_000) }],
      });
      f.metadata.set(`${comparison}?per_page=1&page=2`, { status, commits: [] });
      const result = await verifyClawHubPostpublish(f.options);
      expect(result.complete).toBe(true);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).toMatchObject({
        inventoryDigest: f.entry.inventoryDigest,
        publicationAuthentication: "not-verified",
      });
      expect(f.registryReads.length).toBeGreaterThan(0);
      expect(f.githubReads.filter((path) => path.startsWith("compare/"))).toEqual([
        `${comparison}?per_page=1&page=2`,
      ]);
    },
  );

  it.each(["success", "revoked child", "changed output"])(
    "resumes a failed public readback with retained downloads: %s",
    async (outcome) => {
      const f = fixture();
      const archiveRequests: string[] = [];
      const authorityRequests: string[] = [];
      let publicReadbackAvailable = false;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith("/zip")) {
          archiveRequests.push(url);
        }
        if (/\/actions\/runs\/(10|20)\/attempts\/1$/u.test(url)) {
          authorityRequests.push(url);
        }
        if (!publicReadbackAvailable && url.endsWith("/artifact/download")) {
          return new Response(null, { status: 403 });
        }
        return f.options.fetchImpl(input, init);
      };
      const options = { ...f.options, fetchImpl };
      await expect(verifyClawHubPostpublish(options)).rejects.toThrow(/HTTP 403/u);
      const tarballPath = join(options.outputDir, "3", "example.tgz");
      expect(readFileSync(tarballPath)).toEqual(f.tarball);
      const firstDownloads = [...archiveRequests];
      expect(firstDownloads).toHaveLength(5);
      authorityRequests.length = 0;
      f.registryReads.length = 0;
      publicReadbackAvailable = true;
      if (outcome === "revoked child") {
        f.child.conclusion = "cancelled";
        await expect(verifyClawHubPostpublish(options)).rejects.toThrow(/authorized state/u);
        expect(f.registryReads).toEqual([]);
      } else if (outcome === "changed output") {
        writeFileSync(tarballPath, "changed local bytes");
        await expect(verifyClawHubPostpublish(options)).rejects.toThrow(
          /Retained ClawHub package bytes mismatch/u,
        );
        expect(readFileSync(tarballPath, "utf8")).toBe("changed local bytes");
        expect(f.registryReads).toEqual([]);
      } else {
        expect((await verifyClawHubPostpublish(options)).complete).toBe(true);
      }
      expect(archiveRequests).toEqual(firstDownloads);
      expect(authorityRequests).toEqual([
        `https://api.github.com/repos/${repository}/actions/runs/10/attempts/1`,
        `https://api.github.com/repos/${repository}/actions/runs/20/attempts/1`,
      ]);
    },
  );

  it.each([
    {
      label: "non-ancestor status",
      response: () => Response.json({ status: "behind", commits: [] }),
      error: "Parent tooling is not an ancestor of trusted verification tooling.",
    },
    {
      label: "oversized response",
      response: () => Response.json({ status: "ahead", message: "x".repeat(2 * 1024 * 1024) }),
      error: "GitHub postpublish response body exceeded 2097152 bytes",
    },
    {
      label: "HTTP failure",
      response: () => new Response(null, { status: 404 }),
      error: "GitHub postpublish read returned HTTP 404.",
    },
  ])(
    "rejects a comparison $label before registry reads or evidence",
    async ({ response, error }) => {
      const f = fixture();
      const comparison = `compare/${sha}...${sha}`;
      for (const path of [comparison, `${comparison}?per_page=1&page=2`]) {
        f.metadata.set(path, response());
      }
      await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(error);
      expect(f.registryReads).toEqual([]);
      expect(existsSync(join(f.options.outputDir, "evidence.json"))).toBe(false);
    },
  );

  it.each([
    { runId: 20, patch: { conclusion: "failure" }, error: /authorized state/u },
    { runId: 10, patch: { run_attempt: 2 }, error: /runAttempt mismatch/u },
  ])("rejects changed run authority before registry reads: %j", async ({ runId, patch, error }) => {
    const f = fixture();
    f.metadata.set(`actions/runs/${runId}/attempts/1`, {
      ...(runId === 10 ? f.parent : f.child),
      ...patch,
    });
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(error);
    expect(f.registryReads).toEqual([]);
  });

  it("records an explicit no-child outcome without claiming registry verification", async () => {
    const f = fixture();
    const archive = zip(
      "dispatch.json",
      Buffer.from(
        JSON.stringify({ ...f.dispatch, normalClawHubRunId: null, normalClawHubRunAttempt: null }),
      ),
    );
    f.archives.set(4, archive);
    Object.assign(f.dispatchArtifact, {
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
    });
    const result = await verifyClawHubPostpublish(f.options);
    expect(result).toMatchObject({
      complete: true,
      outcome: "no-normal-clawhub-publication",
      packages: [],
    });
    expect(f.registryReads).toEqual([]);
  });

  it("does not mistake a missing dispatch record for an empty release", async () => {
    const f = fixture();
    f.metadata.set("actions/runs/10/artifacts?per_page=100&page=1", {
      total_count: 0,
      artifacts: [],
    });
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(/dispatch record/u);
    expect(f.registryReads).toEqual([]);
  });

  it("rejects a different parent-approved inventory even when all archive digests verify", async () => {
    const f = fixture();
    const receipt = {
      ...f.receipt,
      packages: [{ ...f.receipt.packages[0], inventoryDigest: "f".repeat(64) }],
    };
    const archive = zip("authorization.json", Buffer.from(JSON.stringify(receipt)));
    f.archives.set(1, archive);
    Object.assign(f.receiptArtifact, {
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
    });
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(
      /Parent authorization packages mismatch/u,
    );
    expect(f.registryReads).toEqual([]);
  });

  it("rejects package archive substitution before contacting the registry", async () => {
    const f = fixture();
    const corrupted = Buffer.from(f.archives.get(3)!);
    corrupted.writeUInt32LE(0, 0);
    f.archives.set(3, corrupted);
    let transfers = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestUrl(input).endsWith("/actions/artifacts/3/zip")) {
        transfers += 1;
      }
      return f.options.fetchImpl(input, init);
    };
    await expect(verifyClawHubPostpublish({ ...f.options, fetchImpl })).rejects.toThrow(/digest/u);
    expect(transfers).toBe(1);
    expect(f.registryReads).toEqual([]);
  });
});
