import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPublicationAdmission,
  createPublicationObservations,
  createPublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import { releaseExecutionPlanSha256 } from "../../scripts/full-release-validation-policy.mjs";
import { npmEvidenceArtifactName } from "../../scripts/plugin-npm-evidence-reuse.mjs";
import {
  PREPARED_NPM_MANIFEST,
  preparedNpmArtifactName,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { createPluginPublicationArtifact } from "../../scripts/plugin-publication-artifact.mjs";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { addRecoveryGraph } from "./plugin-npm-cli-recovery.test-support.mjs";
import { packNpmFixture } from "./plugin-npm-publication-readback.test-support.js";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const cli = resolve("scripts/plugin-npm-prepared-release.mjs");
const transport = pathToFileURL(
  resolve("test/scripts/plugin-npm-cli-transport.test-support.mjs"),
).href;
type ResponseBytes = {
  encoding: "base64" | "utf8";
  data: string;
  after?: { route: string; value: ResponseBytes };
};
type RequestRecord = {
  invocation: string;
  pid: number;
  kind: string;
  route?: string;
  transport?: string;
  callsite?: string;
};

// Materialize external GitHub responses before starting any consumer. The
// subprocess never imports fixture clients or receives an authenticated owner.
// The recovery graph retains the original Q receipts under a distinct P seal.
export async function createNpmCliProcessFixture(
  root: string,
  plugins = "",
  packageCount = 2,
  receiptRecovery = true,
) {
  const f = candidatePublicationFixture();
  const responses: Record<string, ResponseBytes> = {};
  const json = (route: string, value: unknown) => {
    const [path, query] = route.split("?");
    const params = new URLSearchParams(query);
    params.sort();
    const key = query ? path + "?" + params.toString() : route;
    responses[key] = { encoding: "utf8", data: JSON.stringify(value) };
  };
  const bytes = (route: string, value: Uint8Array) => {
    responses[route] = { encoding: "base64", data: Buffer.from(value).toString("base64") };
  };
  json("/rate_limit", { resources: { core: { remaining: 5000, reset: 4_070_908_800 } } });
  const source = (path: string, sha: string, text: string) =>
    json("contents/" + path + "?ref=" + sha, {
      type: "file",
      path,
      encoding: "base64",
      size: Buffer.byteLength(text),
      content: Buffer.from(text).toString("base64"),
      sha: createHash("sha1")
        .update("blob " + Buffer.byteLength(text) + "\0" + text)
        .digest("hex"),
    });
  const metadata = (
    id: number,
    name: string,
    archive: Buffer,
    runId: number,
    sha: string,
    branch: string,
  ) => ({
    id,
    name,
    digest: "sha256:" + digest(archive),
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-08-28T12:01:02.000Z",
    workflow_run: { id: runId, head_sha: sha, head_branch: branch },
  });
  const producer = {
    repository: f.repository,
    runId: 5001,
    runAttempt: 1,
    workflowPath: ".github/workflows/plugin-npm-release.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: f.branch,
    workflowSha: f.q,
    artifactId: 9001,
    artifactName: "",
    artifactDigest: "",
    artifactSizeBytes: 0,
  };
  producer.artifactName = preparedNpmArtifactName(f.q, producer);
  const policy = "name: immutable npm policy\n";
  const projection = expectDefined(f.source.projection, "publication source projection");
  const version = expectDefined(projection.version, "publication source version");
  const packages: Array<{
    extensionId: string;
    packageDir: string;
    packageName: string;
    version: string;
    channel: string;
    publishTag: string;
    installNpmSpec: string;
    route: string;
    artifact: typeof producer;
  }> = [];
  const artifacts = new Map<number, ReturnType<typeof metadata>>();
  const extensionIds = Array.from(
    { length: packageCount },
    (_, index) => ["alpha", "beta"][index] ?? "plugin-" + index,
  );
  for (const [index, extensionId] of extensionIds.entries()) {
    const { packageDir, packageName } = writePublishablePluginFixture(root, {
      extensionId,
      version,
      publishTo: "npm",
    });
    const sourceBytes = readFileSync(join(packageDir, "package.json"));
    const artifactDir = join(root, "artifacts", extensionId);
    const tarballName = extensionId + ".tgz";
    const tarball = join(artifactDir, tarballName);
    await packNpmFixture(join(root, "packed", extensionId), tarball, {
      "package.json": sourceBytes,
      "openclaw.plugin.json": JSON.stringify({ id: extensionId }),
      "dist/index.js": "export default {};",
    });
    const artifactName = "plugin-npm-package-" + extensionId + "-" + version + "-npm-oidc-5001-1";
    const created = createPluginPublicationArtifact({
      artifactDir,
      artifactName,
      packageDir: "extensions/" + extensionId,
      packageName,
      version,
      publishTag: "beta",
      route: "npm-oidc",
      targetSha: f.q,
      sourcePackageJsonSha256: digest(sourceBytes),
      publicationReason: "Stable npm registry preflight selected npm-oidc.",
      publisherPolicy: {
        policyId: "plugin-npm-release-workflow",
        schema: "openclaw.plugin-npm-publisher-policy/v1",
        sha256: digest(policy),
      },
    });
    const archive = makeStoredZip({
      [tarballName]: readFileSync(tarball),
      "plugin-publication-manifest.json": readFileSync(created.manifestPath),
    });
    const id = 9002 + index;
    artifacts.set(id, metadata(id, artifactName, archive, 5001, f.q, f.branch));
    bytes("actions/artifacts/" + id + "/zip", archive);
    packages.push({
      extensionId,
      packageDir: "extensions/" + extensionId,
      packageName,
      version,
      channel: "beta",
      publishTag: "beta",
      installNpmSpec: packageName,
      route: "npm-oidc",
      artifact: {
        ...producer,
        artifactId: id,
        artifactName,
        artifactDigest: "sha256:" + digest(archive),
        artifactSizeBytes: archive.length,
      },
    });
  }
  packages.sort((a, b) =>
    a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0,
  );
  const request = {
    repository: f.source.repository,
    candidateSha: f.source.candidateSha,
    targetContextRef: f.source.targetContextRef,
    tooling: f.source.tooling,
    workflow: f.source.workflow,
    runId: f.source.runId,
    runAttempt: f.source.runAttempt,
    coverage: f.source.coverage,
    validationPurpose: f.source.validationPurpose,
    publicationSelection: f.source.publicationSelection,
    ...(f.source.qualificationAdmission === undefined
      ? {}
      : { qualificationAdmission: f.source.qualificationAdmission }),
    ...(f.source.qualificationInputs === undefined
      ? {}
      : { qualificationInputs: f.source.qualificationInputs }),
  };
  Object.assign(
    f.source,
    createPublicationSourceFact(
      request,
      { packages: [], platforms: [] },
      {
        ...projection,
        version,
        platforms: expectDefined(projection.platforms, "publication source platforms"),
        packages: [
          ...projection.packages,
          ...packages.map((entry) => ({
            name: entry.packageName,
            version: entry.version,
            targets: ["npm"],
          })),
        ].toSorted((a, b) => a.name.localeCompare(b.name)),
      },
    ),
  );
  const admission = f.manifest.publicationAdmission!;
  const npmObservation = expectDefined(admission.observations.npm[0], "original npm observation");
  const observations = createPublicationObservations(f.source, {
    ...admission.observations,
    sourceDigest: f.source.digest,
    npm: [
      ...admission.observations.npm,
      ...packages.map((entry) => ({
        ...npmObservation,
        name: entry.packageName,
        version: entry.version,
      })),
    ].toSorted((a, b) => a.name.localeCompare(b.name)),
  });
  Object.assign(
    admission,
    createPublicationAdmission(
      f.source,
      observations,
      admission.binding.artifact,
      admission.binding.admittedAt,
    ),
  );
  f.plan.sha256 = releaseExecutionPlanSha256(f.plan);
  f.manifest.executionPlanSha256 = f.plan.sha256;
  const prepared = makeStoredZip({
    [PREPARED_NPM_MANIFEST]: JSON.stringify({
      schema: "openclaw.plugin-npm-prepared/v1",
      runtimeQualification: "packed-runtime-v1",
      sourceSha: f.q,
      npmDistTag: "default",
      selectionMode: "all-publishable",
      publisherPolicySha256: digest(policy),
      producer,
      packages,
    }),
  });
  Object.assign(producer, {
    artifactDigest: "sha256:" + digest(prepared),
    artifactSizeBytes: prepared.length,
  });
  artifacts.set(9001, metadata(9001, producer.artifactName, prepared, 5001, f.q, f.branch));
  bytes("actions/artifacts/9001/zip", prepared);
  Object.assign(f.manifest.publicationArtifacts, { pluginNpm: producer });
  const manifestZip = makeStoredZip({
    "full-release-validation-manifest.json": JSON.stringify(f.manifest),
  });
  const planZip = makeStoredZip({ "full-release-execution-plan.json": JSON.stringify(f.plan) });
  for (const [id, name, archive] of [
    [91, "full-release-validation-" + f.runId + "-1", manifestZip],
    [92, "full-release-execution-plan-" + f.runId, planZip],
  ] as const) {
    artifacts.set(id, metadata(id, name, archive, Number(f.runId), f.q, f.branch));
    bytes("actions/artifacts/" + id + "/zip", archive);
  }
  artifacts.set(70, {
    ...f.admission.metadata,
    workflow_run: {
      ...f.admission.metadata.workflow_run,
      head_branch: f.admission.producer.workflowHeadBranch,
    },
  });
  bytes("actions/artifacts/70/zip", f.admission.archive());
  json("actions/runs/40", f.admission.run);
  json("actions/runs/40/attempts/1", f.admission.run);
  json("actions/runs/40/attempts/1/jobs?per_page=100", f.admission.jobs);
  json("actions/runs/40/attempts/1/jobs?per_page=100&page=1", f.admission.jobs);
  json("actions/runs/40/artifacts?per_page=100&page=1", {
    total_count: 1,
    artifacts: [f.admission.metadata],
  });
  for (const [key, text] of f.admission.sources) {
    const split = key.indexOf(":");
    source(key.slice(split + 1), key.slice(0, split), text);
  }
  source(producer.workflowPath, f.q, policy);
  json("git/ref/" + f.publisherFullRef.slice(5), {
    ref: f.publisherFullRef,
    object: { type: "commit", sha: f.p },
  });
  json("collaborators/release-operator/permission", {
    permission: "write",
    user: f.admission.actor,
  });
  json("run view " + f.runId, await f.client.getRunView(f.runId));
  for (const id of [f.runId, ...f.plan.children.map((child) => child.runId)]) {
    const run = await f.client.getRun(id);
    json("actions/runs/" + id, run);
    json("actions/runs/" + id + "/attempts/1", f.client.getRunAttempt(id, 1));
    const jobs = await f.client.getRunAttemptJobs(id);
    const parentJobs = await f.client.getParentJobs(id);
    for (const [path, rows] of [
      ["attempts/1/jobs", jobs],
      ["jobs?filter=all&", parentJobs],
    ] as const) {
      json(
        "actions/runs/" + id + "/" + path + (path.includes("?") ? "" : "?") + "per_page=100&page=1",
        { total_count: rows.length, jobs: rows },
      );
    }
    if (id === f.runId) {
      for (const job of [
        ...parentJobs,
        ...jobs.filter((entry) => entry.name === "Seal release execution plan"),
      ]) {
        responses["actions/jobs/" + job.id + "/logs"] = {
          encoding: "utf8",
          data: await f.client.getJobLog(job.id),
        };
      }
    }
  }
  json("actions/runs/" + f.runId + "/artifacts?per_page=100&page=1", {
    total_count: 2,
    artifacts: [artifacts.get(91), artifacts.get(92)],
  });
  const packageRun = {
    id: 5001,
    run_attempt: 1,
    head_sha: f.q,
    head_branch: f.branch,
    path: producer.workflowPath,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: f.repository },
    head_repository: { full_name: f.repository },
  };
  json("actions/runs/5001/attempts/1", packageRun);
  const packageArtifacts = [...artifacts.values()].filter(
    (entry) => entry.workflow_run.id === 5001,
  );
  json("actions/runs/5001/artifacts?per_page=100&page=1", {
    total_count: packageArtifacts.length,
    artifacts: packageArtifacts,
  });
  const carrierRun = {
    ...packageRun,
    id: 800,
    run_attempt: 2,
    head_sha: f.p,
    head_branch: f.publisherFullRef.replace(/^refs\/(heads|tags)\//u, ""),
    status: "in_progress",
    conclusion: null,
  };
  json("actions/runs/800", carrierRun);
  json("actions/runs/800/attempts/2", carrierRun);
  json("actions/runs/800/attempts/2/jobs?per_page=100", {
    total_count: 1,
    jobs: [
      {
        id: 880,
        name: "preview_plugins_npm",
        run_id: 800,
        run_attempt: 2,
        head_sha: f.p,
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  for (const [id, artifact] of artifacts) {
    json("actions/artifacts/" + id, artifact);
  }
  const ordinaryResponses = { ...responses };
  const recovery = addRecoveryGraph({
    f,
    producer,
    packages,
    artifacts,
    json,
    bytes,
    source,
    metadata,
  });
  if (!receiptRecovery) {
    for (const key of Object.keys(responses)) {
      delete responses[key];
    }
    Object.assign(responses, ordinaryResponses);
  }
  const responseFile = join(root, "responses.json");
  const log = join(root, "requests.jsonl");
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    "#!" +
      process.execPath +
      "\nimport { runGh } from " +
      JSON.stringify(transport) +
      ";\nrunGh(process.argv.slice(2));\n",
    { mode: 0o755 },
  );
  const save = () => writeFileSync(responseFile, JSON.stringify(responses));
  save();
  const env = {
    ...process.env,
    PATH: root + delimiter + process.env.PATH,
    NODE_OPTIONS: "",
    GH_TOKEN: "synthetic-token",
    GITHUB_TOKEN: "synthetic-token",
    OPENCLAW_GH_BIN: gh,
    GITHUB_REPOSITORY: f.repository,
    GITHUB_WORKFLOW_SHA: f.p,
    GITHUB_REF: f.publisherFullRef,
    GITHUB_RUN_ID: "800",
    GITHUB_RUN_ATTEMPT: "2",
    PREPARED_NPM_PARENT_RUN_ID: "700",
    PREPARED_NPM_PARENT_RUN_ATTEMPT: "1",
    PREPARED_NPM_ARTIFACT: JSON.stringify(producer),
    PREPARED_NPM_FRV_RUN_ID: receiptRecovery ? recovery.runId : f.runId,
    PREPARED_NPM_FRV_RUN_ATTEMPT: "1",
    PREPARED_NPM_SELECTION_MODE: plugins ? "selected" : "all-publishable",
    PREPARED_NPM_PLUGINS: plugins,
    PREPARED_NPM_DIST_TAG: "default",
    PREPARED_NPM_EVIDENCE_ID: "",
    PREPARED_NPM_EVIDENCE_DIGEST: "",
    NPM_CLI_RESPONSES: responseFile,
    NPM_CLI_REQUEST_LOG: log,
    NPM_CLI_ENTRYPOINT: cli,
  };
  const records = (): RequestRecord[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const run = (invocation: string, args: string[], replay = true) => {
    const directory = join(root, invocation);
    mkdirSync(directory);
    const output = join(directory, "output");
    const result = spawnSync(
      process.execPath,
      ["--import", transport, cli, ...args, "--source-sha", f.q, "--github-output", output],
      {
        // Publisher jobs contain only trusted tooling, not the source extensions.
        cwd: directory,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...env,
          RUNNER_TEMP: directory,
          NPM_CLI_INVOCATION: invocation,
          ...(replay
            ? { PREPARED_NPM_EVIDENCE_ID: "900", PREPARED_NPM_EVIDENCE_DIGEST: carrierDigest }
            : {}),
        },
      },
    );
    return { ...result, output, directory };
  };
  const evidence = join(root, "preview-evidence.json");
  let carrierDigest = "";
  return {
    f,
    recovery,
    packages,
    previewManifest: join(root, "preview-manifest.json"),
    records,
    responses,
    json,
    bytes,
    save,
    run,
    authorize: (invocation: string, replay = true, index = 0) =>
      run(invocation, ["authorize", "--package", JSON.stringify(packages[index])], replay),
    // Match the workflow: load takes its roster selection from the CLI option,
    // while the environment selection binds the adoption/evidence request.
    preview: (invocation = "preview") =>
      run(
        invocation,
        [
          "load",
          "--selection-mode",
          env.PREPARED_NPM_SELECTION_MODE,
          "--source-root",
          root,
          "--output",
          join(root, "preview-manifest.json"),
          "--evidence-output",
          evidence,
        ],
        false,
      ),
    sealCarrier() {
      // This emulates only GitHub's upload/download transport, not a verifier.
      const payload = JSON.parse(readFileSync(evidence, "utf8"));
      const archive = makeStoredZip({ "plugin-npm-evidence.json": JSON.stringify(payload) });
      carrierDigest = digest(archive);
      const carrier = metadata(
        900,
        npmEvidenceArtifactName(payload.binding),
        archive,
        800,
        f.p,
        carrierRun.head_branch,
      );
      json("actions/artifacts/900", carrier);
      bytes("actions/artifacts/900/zip", archive);
      save();
      return payload;
    },
    consume(invocation: string, index: number, replay = true) {
      const entry = packages[index]!;
      return run(
        invocation,
        [
          "consume",
          "--package",
          JSON.stringify(entry),
          "--source-package-json",
          join(root, entry.packageDir, "package.json"),
          "--cache-dir",
          join(root, invocation + "-cache"),
          "--output-dir",
          join(root, invocation + "-package"),
        ],
        replay,
      );
    },
  };
}
