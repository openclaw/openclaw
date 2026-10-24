import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import * as npm from "../../scripts/npm-prepared-bundle.mjs";
import { validatePreflightManifest } from "../../scripts/release-candidate-checklist.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureGit } from "./release-publish.test-support.js";

// Only the default root pack reaches pnpm; git and tar fixtures keep the real binaries.
const pnpmPack = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; cwd?: string; env: NodeJS.ProcessEnv }>,
  impl: undefined as ((directory: string, destination: string) => unknown) | undefined,
  observer: undefined as ((args: string[]) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSyncMock = (
    file: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => {
    if (file !== "pnpm") {
      return (actual.execFileSync as (...params: unknown[]) => unknown)(file, args, options);
    }
    pnpmPack.calls.push({ args, cwd: options.cwd, env: options.env ?? {} });
    pnpmPack.observer?.(args);
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    if (args.includes("pack")) {
      return pnpmPack.impl?.(options.cwd ?? "", value("--pack-destination"));
    }
    return undefined;
  };
  return { ...actual, execFileSync: execFileSyncMock };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  pnpmPack.impl = undefined;
  pnpmPack.observer = undefined;
  pnpmPack.calls.length = 0;
});
const repository = "openclaw/openclaw";
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const workflowPath = ".github/workflows/full-release-validation.yml";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

async function artifactFixture(
  id: string,
  name: string,
  files: Iterable<readonly [string, Buffer]>,
) {
  const zip = new JSZip();
  for (const [fileName, bytes] of files) {
    zip.file(fileName, bytes);
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });
  const artifact = { id, name, digest: hash(archive), runId: "12", runAttempt: "2" };
  const metadata = {
    id: Number(id),
    name,
    digest: `sha256:${artifact.digest}`,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2026-10-01T00:00:00Z",
    workflow_run: { id: 12, head_sha: toolingSha },
  };
  return { archive, artifact, metadata };
}

function workflowRun(callerWorkflowPath = workflowPath, conclusion: string | null = null) {
  return {
    id: 12,
    run_attempt: 2,
    head_sha: toolingSha,
    path: callerWorkflowPath,
    head_branch: "main",
    event: "workflow_dispatch",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: "in_progress",
    conclusion,
  };
}

function producerJob(producer: ReturnType<typeof packageProducer>) {
  return {
    id: Number(producer.jobId),
    run_id: Number(producer.runId),
    run_attempt: Number(producer.runAttempt),
    head_sha: toolingSha,
    name: producer.jobName,
    status: "completed",
    conclusion: "success",
  };
}

function packageProducer(callerWorkflowPath = workflowPath) {
  return {
    repository,
    workflowRef: `${repository}/${callerWorkflowPath}@refs/heads/main`,
    workflowSha: toolingSha,
    runId: "12",
    runAttempt: "2",
    jobId: "45",
    jobName: "Prepare npm package / Prepare publishable npm package",
    producerWorkflowPath: npm.NPM_PACKAGE_PRODUCER_WORKFLOW,
  };
}

function packSourcePackage(directory: string, destination: string) {
  const { name, version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const staging = tempDirs.make("npm-package-staging-");
  mkdirSync(join(staging, "package"));
  for (const fileName of ["package.json", "npm-shrinkwrap.json"]) {
    if (existsSync(join(directory, fileName))) {
      copyFileSync(join(directory, fileName), join(staging, "package", fileName));
    }
  }
  return execFileSync("tar", [
    "-czf",
    join(destination, `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`),
    "-C",
    staging,
    "package",
  ]);
}

function packageSourceFixture(
  packageVersion: string,
  baseTag?: "same-source" | "different-source",
  dependencies?: Record<string, string>,
) {
  const sourceDir = tempDirs.make("npm-source-");
  const outputDir = join(tempDirs.make("npm-package-output-"), "prepared");
  const write = (name: string, contents: object | string) => {
    const file = join(sourceDir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  const git = fixtureGit(sourceDir, "Release fixture", "release-fixture@example.invalid");
  git("init", "--quiet");
  write("package.json", {
    name: "openclaw",
    version: packageVersion,
    ...(dependencies ? { dependencies } : {}),
  });
  git("add", "package.json");
  git("commit", "--quiet", "-m", "release package fixture");
  if (baseTag) {
    git("tag", `v${packageVersion}`);
    if (baseTag === "different-source") {
      git("commit", "--quiet", "--allow-empty", "-m", "different release source");
    }
  }
  const runPack = vi.fn(packSourcePackage);
  return {
    sourceDir,
    outputDir,
    write,
    releaseRef: git("rev-parse", "HEAD"),
    npmDistTag: "beta",
    producer: packageProducer(),
    runPack,
    runRootPack: runPack,
  };
}

function runtimeLock(name: string, version: string) {
  return {
    packages: {
      "": { dependencies: { [name]: version } },
      [`node_modules/${name}`]: { version },
    },
  };
}

function githubFixture(
  run: ReturnType<typeof workflowRun>,
  jobs: ReturnType<typeof producerJob>[],
  archives: Map<string, { archive: Buffer; metadata: object }>,
  currentRun = false,
) {
  const runGh = (args: string[]) => {
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/jobs?")) {
      return json({ total_count: jobs.length, jobs });
    }
    if (endpoint.endsWith("/attempts/2") || (currentRun && endpoint.endsWith("/runs/12"))) {
      return json(run);
    }
    const artifact =
      !currentRun || endpoint.endsWith("/artifacts/78")
        ? archives.get(endpoint.split("/").at(-1) ?? "")
        : undefined;
    if (artifact) {
      return json(artifact.metadata);
    }
    throw new Error(`Unexpected GitHub request: ${endpoint}`);
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = url.match(/\/artifacts\/(\d+)(\/zip)?$/);
    const artifact = archives.get(match?.[1] ?? "");
    if (!artifact) {
      throw new Error(`Unexpected artifact request: ${url}`);
    }
    return match?.[2]
      ? new Response(new Uint8Array(artifact.archive))
      : Response.json(artifact.metadata);
  };
  return { runGh, fetchImpl };
}

async function bundleFixture(callerWorkflowPath = workflowPath) {
  const producer = packageProducer(callerWorkflowPath);
  const tarball = Buffer.from("exact publishable root archive");
  const aiTarball = Buffer.from("exact publishable AI archive");
  const packageEntry = (packageName: string, tarballName: string, bytes: Buffer) => ({
    packageName,
    packageVersion: "2026.8.1",
    tarballName,
    tarballSha256: hash(bytes),
  });
  const corePackage = packageEntry("@openclaw/ai", "openclaw-ai-2026.8.1.tgz", aiTarball);
  const manifest = {
    schema: "openclaw.npm-package-bundle/v1",
    producer,
    releaseTag: "v2026.8.1",
    releaseSha: sourceSha,
    npmDistTag: "beta",
    ...packageEntry("openclaw", "openclaw-2026.8.1.tgz", tarball),
    corePackageTarballs: [corePackage],
    dependencyTarballs: [corePackage],
  };
  const files = new Map([
    ["package-bundle.json", Buffer.from(json(manifest))],
    [manifest.tarballName, tarball],
    [corePackage.tarballName, aiTarball],
  ]);
  const { archive, artifact, metadata } = await artifactFixture(
    "78",
    "openclaw-npm-package-12-2",
    files,
  );
  const descriptor = {
    schema: npm.PREPARED_NPM_BUNDLE_SCHEMA,
    source: { sha: sourceSha },
    artifact,
    package: {
      name: "openclaw",
      fileName: manifest.tarballName,
      sha256: hash(tarball),
      version: manifest.packageVersion,
      sourceSha,
    },
    corePackages: [corePackage],
    manifestSha256: hash(files.get("package-bundle.json")!),
    producer,
  };
  const run = workflowRun(callerWorkflowPath);
  const job = producerJob(producer);
  const { runGh, fetchImpl } = githubFixture(
    run,
    [job],
    new Map([["78", { archive, metadata }]]),
    true,
  );
  return { descriptor, fetchImpl, files, job, manifest, run, runGh };
}

type PreparedFixtureDescriptor = Awaited<ReturnType<typeof bundleFixture>>["descriptor"];

async function qualificationFixture<
  Descriptor extends Pick<PreparedFixtureDescriptor, "source" | "producer">,
>(
  descriptor: Descriptor,
  pluginSdkApi: object = {},
  dependencyReports: Record<string, object | string> = {},
) {
  const source = descriptor.source;
  const makeProducer = (jobId: string, jobName: string) => ({
    ...descriptor.producer,
    jobId,
    jobName,
  });
  const sourceCheck = {
    schema: npm.NPM_SOURCE_CHECK_SCHEMA,
    source,
    producer: makeProducer("46", "Check npm release source"),
  };
  const identity = {
    schema: npm.NPM_QUALIFICATION_PROOF_SCHEMA,
    source,
    releaseTag: "v2026.8.1",
    npmDistTag: "beta",
  };
  const contentsProof = {
    ...identity,
    kind: "contents",
    producer: makeProducer("47", "Check npm package contents"),
    files: [],
    preparedBundle: descriptor,
  };
  const archives = new Map<string, { archive: Buffer; metadata: object }>();
  const makeArtifactProof = async (
    kind: string,
    id: string,
    producer: ReturnType<typeof makeProducer>,
    files: Record<string, object | string>,
  ) => {
    const entries = Object.entries(files).map(
      ([name, value]) =>
        [name, Buffer.from(typeof value === "string" ? value : json(value))] as const,
    );
    const { archive, artifact, metadata } = await artifactFixture(
      id,
      `openclaw-npm-${kind}-proof-${producer.runId}-${producer.runAttempt}`,
      entries,
    );
    archives.set(id, { archive, metadata });
    return {
      ...identity,
      kind,
      producer,
      artifact,
      files: entries.map(([name, bytes]) => ({ name, sha256: hash(bytes) })),
    };
  };
  const sdkProof = await makeArtifactProof(
    "sdk",
    "79",
    makeProducer("48", "Check npm Plugin SDK"),
    {
      "plugin-sdk-api-release-evidence.json": pluginSdkApi,
      "plugin-sdk-api-release-diff.json": {},
    },
  );
  const dependencyProof = await makeArtifactProof(
    "dependencies",
    "80",
    makeProducer("49", "Check npm dependencies"),
    {
      "dependency-evidence-manifest.json": { releaseSha: source.sha },
      ...dependencyReports,
    },
  );
  const jobs = [sourceCheck, contentsProof, sdkProof, dependencyProof].map(({ producer }) =>
    producerJob(producer),
  );
  const { runGh, fetchImpl } = githubFixture(workflowRun(), jobs, archives);
  return {
    sourceCheck,
    contentsProof,
    sdkProof,
    dependencyProof,
    runGh,
    fetchImpl,
    jobs,
    archives,
    token: "test-token",
  };
}

type QualificationFixture = Awaited<
  ReturnType<typeof qualificationFixture<PreparedFixtureDescriptor>>
>;

type BundleFixture = Awaited<ReturnType<typeof bundleFixture>>;
type AttemptChanges = {
  current?: Partial<ReturnType<typeof workflowRun>>;
  reread?: Partial<ReturnType<typeof workflowRun>>;
  receipt?: Partial<ReturnType<typeof producerJob> & { started_at: string }>;
  noJobs?: boolean;
};

function validateDescriptor(descriptor: PreparedFixtureDescriptor, sha = sourceSha) {
  return npm.validatePreparedNpmBundleDescriptor({
    descriptor,
    repository,
    sourceSha: sha,
    toolingSha,
  });
}

function laterAttemptRequests(
  fixture: BundleFixture,
  changes: AttemptChanges = {},
  { project = false, requests = [] }: { project?: boolean; requests?: string[] } = {},
) {
  let reads = 0;
  return (args: string[]) => {
    const endpoint = args[1] ?? "";
    requests.push(endpoint);
    if (endpoint.endsWith("/runs/12")) {
      return json({
        ...fixture.run,
        run_attempt: 3,
        ...changes.current,
        ...(++reads === 2 ? changes.reread : {}),
      });
    }
    if (endpoint.includes("/attempts/3/jobs?")) {
      const entries = changes.noJobs
        ? []
        : [
            {
              ...fixture.job,
              id: 46,
              run_attempt: 3,
              name: "Seal artifact receipt",
              ...changes.receipt,
            },
          ];
      const input = JSON.stringify({ total_count: entries.length, jobs: entries });
      // Preserve the real --jq projection in the carried-forward job regression.
      return project
        ? execFileSync("jq", ["-c", args[args.indexOf("--jq") + 1]!], { input, encoding: "utf8" })
        : input;
    }
    return fixture.runGh(args);
  };
}

function publicationOptions(fixture: BundleFixture, runGh = fixture.runGh, qualified = true) {
  return {
    producer: { ...fixture.descriptor.producer, jobName: fixture.job.name },
    repository,
    toolingSha,
    qualified,
    requireCompletedParent: true,
    runGh,
  };
}

function downloadFixture(
  fixture: BundleFixture,
  outputDir: string,
  options: { releaseTag?: string; fetchImpl?: typeof fetch } = {},
) {
  return npm.downloadPreparedNpmBundle({
    ...fixture,
    repository,
    sourceSha,
    toolingSha,
    outputDir,
    token: "test-token",
    npmDistTag: "beta",
    ...options,
  });
}

function qualifyFixture(
  descriptor: PreparedFixtureDescriptor,
  inputDir: string,
  outputDir: string,
  proof: QualificationFixture,
) {
  return npm.qualifyNpmPackageBundle({
    descriptor,
    inputDir,
    outputDir,
    producer: { ...descriptor.producer, jobId: "50", jobName: "Qualify prepared npm package" },
    ...proof,
  });
}

function writeBundleInput(fixture: BundleFixture, prefix: string) {
  const inputDir = tempDirs.make(prefix);
  for (const [name, bytes] of fixture.files) {
    writeFileSync(join(inputDir, name), bytes);
  }
  return inputDir;
}

it("reuses successful preparation and source jobs after parent failure", async () => {
  const fixture = await bundleFixture(".github/workflows/openclaw-npm-release.yml");
  Object.assign(fixture.run, { status: "completed", conclusion: "failure" });
  const downloaded = await downloadFixture(fixture, join(tempDirs.make("npm-retry-"), "prepared"), {
    releaseTag: fixture.manifest.releaseTag,
  });
  expect(readFileSync(downloaded.tarballPath)).toEqual(
    fixture.files.get(fixture.manifest.tarballName),
  );
  const descriptor = {
    schema: npm.NPM_SOURCE_CHECK_SCHEMA,
    source: { sha: sourceSha },
    producer: { ...fixture.descriptor.producer, jobName: "Check npm release source" },
  };
  fixture.job.name = descriptor.producer.jobName;
  const source = { descriptor, repository, sourceSha, toolingSha, runGh: fixture.runGh };
  expect(npm.verifyNpmSourceCheck(source).job.id).toBe(fixture.job.id);
  fixture.job.run_attempt += 1;
  expect(() => npm.verifyNpmSourceCheck(source)).toThrow("unique exact completed producer job");
});

it.each([
  ["completed", "failure"],
  ["in_progress", null],
])("requires a successful parent for publication (%s/%s)", async (status, conclusion) => {
  const fixture = await bundleFixture(".github/workflows/openclaw-npm-release.yml");
  Object.assign(fixture.run, { status, conclusion });
  fixture.job.name = "Qualify prepared npm package";
  const options = publicationOptions(fixture);
  expect(() => npm.verifyNpmBundleProducer(options)).toThrow("parent");
  Object.assign(fixture.run, { status: "completed", conclusion: "success" });
  expect(npm.verifyNpmBundleProducer(options).job.id).toBe(fixture.job.id);
  fixture.job.conclusion = "failure";
  expect(() => npm.verifyNpmBundleProducer(options)).toThrow("unique exact completed producer job");
});

it("retains the exact green qualifier when only a later receipt job is retried", async () => {
  const fixture = await bundleFixture();
  Object.assign(fixture.run, { status: "completed", conclusion: "failure" });
  fixture.job.name = "Qualify prepared npm package";
  const requests: string[] = [];
  const runGh = laterAttemptRequests(fixture, { current: { conclusion: "success" } }, { requests });
  const result = npm.verifyNpmBundleProducer(publicationOptions(fixture, runGh));
  expect(result).toMatchObject({
    run: { run_attempt: 3 },
    job: { id: fixture.job.id, run_attempt: 2 },
  });
  expect(requests.filter((endpoint) => endpoint.endsWith("/runs/12"))).toHaveLength(2);
  expect(requests.some((endpoint) => endpoint.includes("/attempts/3/jobs?"))).toBe(true);
});

it.each([
  ["carried-forward copy", "2026-08-01T00:00:00Z", true],
  ["re-executed job", "2026-08-01T01:00:00Z", false],
] as const)("checks later attempts for the producer job: %s", async (_, startedAt, accepted) => {
  const fixture = await bundleFixture();
  Object.assign(fixture.run, { status: "completed", conclusion: "success" });
  Object.assign(fixture.job, {
    started_at: "2026-08-01T00:00:00Z",
    completed_at: "2026-08-01T00:10:00Z",
  });
  const runGh = laterAttemptRequests(
    fixture,
    { receipt: { id: 47, name: fixture.job.name, started_at: startedAt } },
    { project: true },
  );
  const verify = () => npm.verifyNpmBundleProducer(publicationOptions(fixture, runGh, false));
  if (accepted) {
    expect(verify().job.id).toBe(fixture.job.id);
  } else {
    expect(verify).toThrow("superseded by a later attempt");
  }
});

it.each<[string, AttemptChanges]>([
  ["superseded qualifier", { receipt: { name: "Qualify prepared npm package" } }],
  ["missing attempt jobs", { noJobs: true }],
  ["mismatched attempt jobs", { receipt: { run_attempt: 2 } }],
  ["changed current tooling", { current: { head_sha: "d".repeat(40) } }],
  ["current attempt regressed", { current: { run_attempt: 1 } }],
  ["current attempt advanced during verification", { reread: { run_attempt: 4 } }],
  [
    "current run restarted during verification",
    { reread: { status: "in_progress", conclusion: null } },
  ],
])("rejects stale producer proof: %s", async (_scenario, changes) => {
  const fixture = await bundleFixture();
  Object.assign(fixture.run, { status: "completed", conclusion: "success" });
  fixture.job.name = "Qualify prepared npm package";
  const runGh = laterAttemptRequests(fixture, changes);
  expect(() => npm.verifyNpmBundleProducer(publicationOptions(fixture, runGh))).toThrow(
    /producer|attempt evidence/,
  );
});

it.each([false, true])(
  "checks packed legacy runtime dependencies before sealing (complete=%s)",
  (complete) => {
    const fixture = packageSourceFixture("2026.7.33", undefined, { "runtime-fixture": "1.0.0" });
    // Use a non-workspace runtime: coverage must protect every declared dependency,
    // not just the AI package whose omission broke 2026.7.33.
    fixture.write(
      "npm-shrinkwrap.json",
      complete ? runtimeLock("runtime-fixture", "1.0.0") : { packages: { "": {} } },
    );
    if (complete) {
      expect(npm.prepareNpmPackageBundle(fixture).packageVersion).toBe("2026.7.33");
    } else {
      expect(() => npm.prepareNpmPackageBundle(fixture)).toThrow(
        "npm-shrinkwrap.json is missing declared dependency runtime-fixture",
      );
    }
    expect(existsSync(join(fixture.outputDir, "package-bundle.json"))).toBe(complete);
  },
);

it("sanitizes with trusted tooling before inventory and hoisted packing", () => {
  const { runRootPack: _runRootPack, runPack, ...fixture } = packageSourceFixture("2026.8.33");
  const marker = join(fixture.sourceDir, "candidate-typescript-loaded");
  const distRoot = join(fixture.sourceDir, "dist");
  mkdirSync(distRoot);
  fixture.write("node_modules/typescript/package.json", {
    name: "typescript",
    type: "module",
    exports: { "./unstable/*": "./forbidden.mjs" },
  });
  fixture.write(
    "node_modules/typescript/forbidden.mjs",
    [
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded");`,
      `throw new Error("loaded frozen candidate compiler");`,
    ].join("\n"),
  );
  writeFileSync(join(distRoot, "chunk.d.ts"), "export { __exportAll as helper };\n");
  const steps: string[] = [];
  pnpmPack.impl = runPack;
  pnpmPack.observer = (args) => steps.push(args.includes("pack") ? "pack" : String(args.at(-1)));
  const refreshRootDistInventory = vi.fn((root: string) => {
    expect(root).toBe(fixture.sourceDir);
    expect(readFileSync(join(distRoot, "chunk.d.ts"), "utf8")).toBe("export { };\n");
    steps.push("inventory");
  });
  expect(npm.prepareNpmPackageBundle({ ...fixture, refreshRootDistInventory }).packageVersion).toBe(
    "2026.8.33",
  );
  expect(refreshRootDistInventory).toHaveBeenCalledTimes(1);
  expect(steps).toEqual(["prepack", "inventory", "pack", "postpack"]);
  expect(pnpmPack.calls).toEqual(
    [
      ["run", "prepack"],
      [
        "pack",
        "--config.ignore-scripts=true",
        "--config.node-linker=hoisted",
        "--pack-destination",
        fixture.outputDir,
      ],
      ["run", "--if-present", "postpack"],
    ].map((args) => ({
      args,
      cwd: fixture.sourceDir,
      env: expect.objectContaining({ OPENCLAW_PREPACK_PREPARED: "1" }),
    })),
  );

  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(join(distRoot, "chunk.d.ts"), "utf8")).toBe("export { };\n");
});

it.each([true, false])(
  "prepares a legacy root shrinkwrap before sealing (has shrinkwrap=%s)",
  (hasShrinkwrap) => {
    const version = "2026.7.34";
    const fixture = packageSourceFixture(version, undefined, { "@openclaw/ai": version });
    fixture.write("packages/ai/package.json", { name: "@openclaw/ai", version });
    if (hasShrinkwrap) {
      fixture.write("npm-shrinkwrap.json", runtimeLock("@openclaw/ai", "2026.7.33"));
    }
    const prepareRootShrinkwrap = vi.fn(({ aiTarballPath }: { aiTarballPath: string }) => {
      expect(existsSync(aiTarballPath)).toBe(true);
      const shrinkwrapPath = join(fixture.sourceDir, "npm-shrinkwrap.json");
      const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
      shrinkwrap.packages[""].dependencies["@openclaw/ai"] = version;
      shrinkwrap.packages["node_modules/@openclaw/ai"].version = version;
      writeJson(shrinkwrapPath, shrinkwrap);
    });

    const prepared = npm.prepareNpmPackageBundle({ ...fixture, prepareRootShrinkwrap });

    expect(prepareRootShrinkwrap).toHaveBeenCalledTimes(hasShrinkwrap ? 1 : 0);
    expect(prepared.dependencyTarballs).toHaveLength(1);
  },
);

it.each([
  ["2026.8.1", "v2026.8.1-2", "same-source"],
  ["2026.8.1-2", "v2026.8.1-2", undefined],
  ["2026.8.1", undefined, undefined],
] as const)(
  "preserves package %s and requested tag %s through preparation and qualification",
  async (packageVersion, releaseTag, baseTag) => {
    const fixture = packageSourceFixture(packageVersion, baseTag);
    const prepared = npm.prepareNpmPackageBundle({ ...fixture, releaseTag });
    const expectedTag = releaseTag ?? `v${packageVersion}`;
    expect(prepared).toMatchObject({ releaseTag: expectedTag, releaseSha: fixture.releaseRef });
    const descriptor = npm.describeNpmBundle({
      directory: fixture.outputDir,
      artifact: {
        id: "78",
        name: "openclaw-npm-package-12-2",
        digest: "c".repeat(64),
        runId: "12",
        runAttempt: "2",
      },
    });
    if (!("package" in descriptor)) {
      throw new Error("Expected an unqualified package bundle descriptor");
    }
    validateDescriptor(descriptor, fixture.releaseRef);
    const proof = await qualificationFixture(descriptor);
    for (const entry of [proof.sdkProof, proof.dependencyProof, proof.contentsProof]) {
      const directory = tempDirs.make("npm-qualification-evidence-");
      const artifact = "artifact" in entry ? entry.artifact : undefined;
      if (artifact) {
        const archive = await JSZip.loadAsync(proof.archives.get(artifact.id)!.archive);
        for (const file of entry.files) {
          writeFileSync(
            join(directory, file.name),
            await archive.file(file.name)!.async("nodebuffer"),
          );
        }
      }
      Object.assign(
        entry,
        npm.describeNpmQualificationProof({
          ...fixture,
          kind: entry.kind,
          releaseTag,
          directory,
          producer: entry.producer,
          artifact,
          preparedBundle: descriptor,
        }),
      );
    }
    const outputDir = join(tempDirs.make("npm-qualified-output-"), "qualified");
    const qualified = await qualifyFixture(descriptor, fixture.outputDir, outputDir, proof);
    expect(qualified).toMatchObject({ releaseTag: expectedTag, packageVersion });
    const params = { tag: expectedTag, targetSha: fixture.releaseRef, npmDistTag: "beta" };
    expect(() => validatePreflightManifest(qualified, params)).not.toThrow();
    expect(() => validatePreflightManifest(qualified, { ...params, tag: "v2026.8.1-3" })).toThrow(
      "npm preflight tag mismatch",
    );
    expect(
      JSON.parse(
        execFileSync(
          "tar",
          ["-xOf", join(outputDir, qualified.tarballName), "package/package.json"],
          { encoding: "utf8" },
        ),
      ).version,
    ).toBe(packageVersion);
    expect(readFileSync(join(outputDir, qualified.tarballName))).toEqual(
      readFileSync(join(fixture.outputDir, prepared.tarballName)),
    );
  },
);

it.each([
  ["missing base tag", "2026.8.1", undefined, false],
  ["base tag at another source", "2026.8.1", "different-source", false],
  ["different package base", "2026.8.2", "same-source", false],
  ["different requested source", "2026.8.1", "same-source", true],
] as const)(
  "rejects a correction with %s before packing",
  (_label, version, baseTag, wrongSource) => {
    const fixture = packageSourceFixture(version, baseTag);
    expect(() =>
      npm.prepareNpmPackageBundle({
        ...fixture,
        releaseTag: "v2026.8.1-2",
        releaseRef: wrongSource ? "f".repeat(40) : fixture.releaseRef,
      }),
    ).toThrow();
    expect(fixture.runPack).not.toHaveBeenCalled();
    expect(existsSync(fixture.outputDir)).toBe(false);
  },
);

it("qualifies exact package bytes with large SDK and npm lock evidence", async () => {
  const fixture = await bundleFixture();
  const directory = tempDirs.make("npm-bundle-");
  const inputDir = join(directory, "prepared");
  const outputDir = join(directory, "qualified");
  const downloaded = await downloadFixture(fixture, inputDir);
  expect(readFileSync(downloaded.tarballPath)).toEqual(
    fixture.files.get(fixture.manifest.tarballName),
  );
  const npmLocks = `${JSON.stringify({ packages: [{ lock: { packages: { "": { description: "x".repeat(3 * 1024 * 1024) } } } }] })}\n`;
  const dependencyReports = {
    ...Object.fromEntries(
      [
        "dependency-vulnerability-gate",
        "transitive-manifest-risk-report",
        "dependency-ownership-surface-report",
        "dependency-changes-report",
      ].flatMap((name) => [
        [`${name}.json`, {}],
        [`${name}.md`, "# Report\n"],
      ]),
    ),
    "dependency-evidence-summary.md": "# Dependency evidence\n",
    "npm-package-locks.json": npmLocks,
    "npm-package-locks.md": "# npm package-lock mirrors\n",
  };
  const proof = await qualificationFixture(
    fixture.descriptor,
    {
      baseline: "published",
      // Extended-stable comparisons can exceed 16 MiB across declaration history.
      diff: { exports: [{ before: "export type Previous = unknown;\n".repeat(575_000) }] },
    },
    dependencyReports,
  );
  const manifest = await qualifyFixture(fixture.descriptor, inputDir, outputDir, proof);
  const manifestBytes = readFileSync(join(outputDir, "preflight-manifest.json"));
  expect(manifestBytes.byteLength).toBe(Buffer.byteLength(`${JSON.stringify(manifest)}\n`));
  expect(manifest.version).toBe(3);
  expect(manifest.preparedBundle).toEqual(fixture.descriptor);
  for (const [name, value] of Object.entries(dependencyReports)) {
    expect(readFileSync(join(outputDir, "dependency-evidence", name), "utf8")).toBe(
      typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    );
  }
  for (const entry of [
    fixture.descriptor.package.fileName,
    ...fixture.descriptor.corePackages.map((pkg) => pkg.tarballName),
  ]) {
    expect(readFileSync(join(outputDir, entry))).toEqual(fixture.files.get(entry));
  }
  expect(
    npm.describeNpmBundle({
      directory: outputDir,
      artifact: fixture.descriptor.artifact,
      qualified: true,
    }),
  ).toMatchObject({
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: sourceSha },
    preparedBundle: fixture.descriptor,
  });
});

it.each([
  ["wrong publication tag", "release tag mismatch"],
  ["unfinished producer", "unique exact completed producer job"],
])("rejects %s before extracting artifacts", async (scenario, error) => {
  const fixture = await bundleFixture();
  const unfinished = scenario === "unfinished producer";
  if (unfinished) {
    fixture.job.status = "in_progress";
  }
  const outputDir = join(tempDirs.make("npm-rejected-download-"), "output");
  await expect(
    downloadFixture(fixture, outputDir, {
      releaseTag: unfinished ? fixture.manifest.releaseTag : "v2026.8.1-2",
      fetchImpl: unfinished
        ? async () => {
            throw new Error("must not download before producer success");
          }
        : fixture.fetchImpl,
    }),
  ).rejects.toThrow(error);
  expect(existsSync(outputDir)).toBe(false);
});

it("rejects a descriptor for another source or reusable owner", async () => {
  const { descriptor } = await bundleFixture();
  expect(() => validateDescriptor(descriptor, "c".repeat(40))).toThrow("source SHA mismatch");
  descriptor.producer.producerWorkflowPath = ".github/workflows/ci.yml";
  expect(() => validateDescriptor(descriptor)).toThrow("trusted preflight owner");
});

it.each<
  [string, (proof: QualificationFixture, fixture: BundleFixture, inputDir: string) => void, string]
>([
  [
    "substituted tarball",
    (_proof, fixture, inputDir) => {
      writeFileSync(join(inputDir, fixture.manifest.tarballName), "replacement archive");
    },
    "tarball digest mismatch",
  ],
  [
    "source check still running",
    (proof) => Object.assign(proof.jobs[0]!, { status: "in_progress" }),
    "unique exact completed producer job",
  ],
  [
    "dependency check failed",
    (proof) => Object.assign(proof.jobs[3]!, { conclusion: "failure" }),
    "unique exact completed producer job",
  ],
  [
    "SDK proof from another attempt",
    (proof) => Object.assign(proof.jobs[2]!, { run_attempt: 1 }),
    "unique exact completed producer job",
  ],
  [
    "contents checked another tarball",
    (proof) => {
      proof.contentsProof.preparedBundle = structuredClone(proof.contentsProof.preparedBundle);
      proof.contentsProof.preparedBundle.package.sha256 = "f".repeat(64);
    },
    "Package contents proof input",
  ],
  [
    "dependency proof from another source",
    (proof) => Object.assign(proof.dependencyProof, { source: { sha: "c".repeat(40) } }),
    "dependencies proof source",
  ],
  [
    "SDK archive replaced",
    (proof) => {
      const artifact = proof.archives.get("79")!;
      artifact.archive = Buffer.alloc(artifact.archive.length);
    },
    "GitHub Actions artifact download digest",
  ],
  [
    "SDK proof rebound to another tag",
    (proof) => Object.assign(proof.sdkProof, { releaseTag: "v2026.8.1-2" }),
    "sdk proof release tag",
  ],
])("does not seal while %s", async (_name, mutate, expectedError) => {
  const fixture = await bundleFixture();
  const inputDir = writeBundleInput(fixture, "npm-proof-input-");
  const outputDir = join(inputDir, "qualified");
  const proof = await qualificationFixture(fixture.descriptor);
  mutate(proof, fixture, inputDir);
  await expect(qualifyFixture(fixture.descriptor, inputDir, outputDir, proof)).rejects.toThrow(
    expectedError,
  );
  expect(existsSync(outputDir)).toBe(false);
});
