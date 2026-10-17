import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createVercelContainerRegistryPublishPlan,
  promoteVercelContainerRegistryAliases,
  publishVercelContainerRegistryImages,
} from "../../scripts/vercel-container-registry-publish.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const sourceImage = "ghcr.io/openclaw/openclaw";
const targetImage = "vcr.vercel.com/openclaw-foundation/openclaw/openclaw";
const amd64Digest = `sha256:${"1".repeat(64)}`;
const arm64Digest = `sha256:${"2".repeat(64)}`;
const attestationDigest = `sha256:${"3".repeat(64)}`;
const changedDigest = `sha256:${"4".repeat(64)}`;
const cleanIndexDigest = `sha256:${"5".repeat(64)}`;
const defaultSourceDigest = `sha256:${"6".repeat(64)}`;
const slimSourceDigest = `sha256:${"7".repeat(64)}`;
const browserSourceDigest = `sha256:${"8".repeat(64)}`;
const browserArm64Digest = `sha256:${"9".repeat(64)}`;
const configDigest = `sha256:${"a".repeat(64)}`;
const layerDigest = `sha256:${"b".repeat(64)}`;
const immutableSourceRefs = [
  `default=${sourceImage}@${defaultSourceDigest}`,
  `slim=${sourceImage}@${slimSourceDigest}`,
  `browser=${sourceImage}@${browserSourceDigest}`,
];
const imageIndexMediaType = "application/vnd.oci.image.index.v1+json";
const imageManifestMediaType = "application/vnd.oci.image.manifest.v1+json";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  "continue-on-error"?: boolean | string;
  environment?: string;
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
  uses?: string;
  with?: Record<string, boolean | string>;
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
      outputs?: Record<string, { description?: string; value?: string }>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
    };
  };
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function requireJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return job;
}

function indexManifest(
  architectures: Array<"amd64" | "arm64">,
  includeAttestations = true,
  armDigest = arm64Digest,
) {
  const manifests = architectures.flatMap((architecture) => {
    const digest = architecture === "amd64" ? amd64Digest : armDigest;
    const image = {
      digest,
      mediaType: imageManifestMediaType,
      platform: { architecture, os: "linux" },
    };
    if (!includeAttestations) {
      return [image];
    }
    return [
      image,
      {
        annotations: {
          "vnd.docker.reference.digest": digest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        digest: attestationDigest,
        mediaType: imageManifestMediaType,
        platform: { architecture: "unknown", os: "unknown" },
      },
    ];
  });
  return JSON.stringify({ manifests, mediaType: imageIndexMediaType });
}

function architectureForRef(ref: string): "amd64" | "arm64" | undefined {
  if (ref.endsWith("-amd64")) {
    return "amd64";
  }
  if (ref.endsWith("-arm64")) {
    return "arm64";
  }
  return undefined;
}

function requireCommandRef(args: string[]): string {
  const ref = args[3] === "--raw" ? args[4] : args[3];
  if (!ref) {
    throw new Error(`Expected an imagetools image reference in ${JSON.stringify(args)}.`);
  }
  return ref;
}

function imageConfig(version: string) {
  return JSON.stringify({
    config: { Labels: { "org.opencontainers.image.version": version } },
  });
}

function platformManifest() {
  return {
    schemaVersion: 2,
    mediaType: imageManifestMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: 256,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layerDigest,
        size: 1024,
      },
    ],
  };
}

function publishParams(version: string, includeBrowser: boolean) {
  return {
    includeBrowser,
    sourceRefs: includeBrowser ? immutableSourceRefs : immutableSourceRefs.slice(0, 2),
    targetImage,
    version,
  };
}

function successfulExecutor(
  calls: string[][],
  options: {
    changedTargetRef?: string;
    currentAliasVersion?: string;
    sourceVersions?: Record<string, string>;
    sourceImageConfigs?: Record<string, string>;
    rawManifests?: Record<string, string | Error>;
    unattestedSourceRef?: string;
    version?: string;
  } = {},
) {
  const version = options.version ?? "2026.7.2";
  const rawManifests: Record<string, string | Error> = {
    ...Object.fromEntries(
      [defaultSourceDigest, slimSourceDigest, browserSourceDigest].map((digest) => [
        `${sourceImage}@${digest}`,
        indexManifest(
          ["amd64", "arm64"],
          `${sourceImage}@${digest}` !== options.unattestedSourceRef,
          digest === browserSourceDigest ? browserArm64Digest : arm64Digest,
        ),
      ]),
    ),
    ...Object.fromEntries(
      [amd64Digest, arm64Digest, browserArm64Digest].map((digest) => [
        `${sourceImage}@${digest}`,
        JSON.stringify(platformManifest()),
      ]),
    ),
    ...options.rawManifests,
  };
  return vi.fn((_command: string, args: string[]) => {
    calls.push(args);
    if (args[2] === "create") {
      return "";
    }
    const ref = requireCommandRef(args);
    if (args.at(-1)?.includes(".Image")) {
      const platform = args.at(-1)?.includes("linux/arm64") ? "linux/arm64" : "linux/amd64";
      if (ref.includes("@") && options.sourceImageConfigs?.[platform] !== undefined) {
        return options.sourceImageConfigs[platform];
      }
      return imageConfig(
        ref.includes("@")
          ? (options.sourceVersions?.[ref] ?? version)
          : (options.currentAliasVersion ?? version),
      );
    }
    if (ref === `${sourceImage}@${attestationDigest}`) {
      return JSON.stringify({
        artifactType: "application/vnd.docker.attestation.manifest.v1+json",
        layers: ["https://spdx.dev/Document", "https://slsa.dev/provenance/v1"].map(
          (predicate) => ({ annotations: { "in-toto.io/predicate-type": predicate } }),
        ),
      });
    }
    if (ref.startsWith(sourceImage)) {
      const raw = rawManifests[ref];
      if (!args.includes("--raw") || raw === undefined) {
        throw new Error(`Unexpected source inspection: ${JSON.stringify(args)}`);
      }
      if (raw instanceof Error) {
        throw raw;
      }
      return raw;
    }
    const armDigest = ref.includes("-browser") ? browserArm64Digest : arm64Digest;
    if (args.at(-1) === "--raw") {
      return indexManifest(["amd64", "arm64"], false, armDigest);
    }
    const architecture = architectureForRef(ref);
    const expectedDigest = architecture === "arm64" ? armDigest : amd64Digest;
    return JSON.stringify({
      digest:
        ref === options.changedTargetRef
          ? changedDigest
          : architecture
            ? expectedDigest
            : cleanIndexDigest,
      mediaType: architecture ? imageManifestMediaType : imageIndexMediaType,
    });
  });
}

function admissionFixture(raw: string | Error, { digest = amd64Digest } = {}) {
  const calls: string[][] = [];
  const execFileSyncImpl = successfulExecutor(calls, {
    rawManifests: { [`${sourceImage}@${digest}`]: raw },
  });
  return {
    calls,
    publish: () =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        beforeMutation: () => undefined,
        log: () => {},
      }),
  };
}

const toolingSha = "c".repeat(40);
const toolingTag = `release-publish/${toolingSha.slice(0, 12)}-12345`;
const vcrWorkflowPath = ".github/workflows/vercel-container-registry-publish.yml";
const releaseWorkflowPath = ".github/workflows/openclaw-release-publish.yml";
const immutableWrites = [
  "2026.7.2",
  "2026.7.2-amd64",
  "2026.7.2-arm64",
  "2026.7.2-slim",
  "2026.7.2-slim-amd64",
  "2026.7.2-slim-arm64",
  "2026.7.2-browser",
  "2026.7.2-browser-amd64",
  "2026.7.2-browser-arm64",
].map((tag) => `create:${targetImage}:${tag}`);
const aliasWrites = [
  `create:${targetImage}:latest,${targetImage}:main`,
  `create:${targetImage}:slim,${targetImage}:main-slim`,
  `create:${targetImage}:latest-browser,${targetImage}:main-browser`,
];

type AuthorityFixtureState = {
  effects: string[];
  run: Record<string, unknown>;
  tagSha: string;
  comparisonStatus: string;
  unreadableRun: boolean;
  revokeAfter: string;
  sandboxNotReady: boolean;
};

// Only external commands are fixtures. Both the publisher CLI and canonical
// authority verifier execute unchanged, including the workflow's shell bodies.
function authorityFixture(route: "automatic" | "automatic-main" | "manual" = "automatic") {
  const directory = tempDirs.make("openclaw-vcr-authority-");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const manual = route === "manual";
  const ref = route === "automatic" ? toolingTag : "main";
  const fullRef = ref === "main" ? "refs/heads/main" : `refs/tags/${ref}`;
  const workflowPath = manual ? vcrWorkflowPath : releaseWorkflowPath;
  const statePath = join(directory, "state.json");
  const state: AuthorityFixtureState = {
    effects: [],
    run: {
      id: 67890,
      run_attempt: 2,
      repository: { full_name: "openclaw/openclaw" },
      path: `${workflowPath}@${fullRef}`,
      event: "workflow_dispatch",
      head_branch: ref,
      head_sha: toolingSha,
      status: "in_progress",
      conclusion: null,
    },
    tagSha: toolingSha,
    comparisonStatus: "ahead",
    unreadableRun: false,
    revokeAfter: "",
    sandboxNotReady: false,
  };
  writeFileSync(statePath, JSON.stringify(state));
  const rawManifests = {
    ...Object.fromEntries(
      [defaultSourceDigest, slimSourceDigest, browserSourceDigest].map((digest) => [
        `${sourceImage}@${digest}`,
        indexManifest(
          ["amd64", "arm64"],
          true,
          digest === browserSourceDigest ? browserArm64Digest : arm64Digest,
        ),
      ]),
    ),
    ...Object.fromEntries(
      [amd64Digest, arm64Digest, browserArm64Digest].map((digest) => [
        `${sourceImage}@${digest}`,
        JSON.stringify(platformManifest()),
      ]),
    ),
    [`${sourceImage}@${attestationDigest}`]: JSON.stringify({
      artifactType: "application/vnd.docker.attestation.manifest.v1+json",
      layers: ["https://spdx.dev/Document", "https://slsa.dev/provenance/v1"].map((predicate) => ({
        annotations: { "in-toto.io/predicate-type": predicate },
      })),
    }),
  };
  const commandFixture = join(directory, "commands.mjs");
  writeFileSync(
    commandFixture,
    `import { readFileSync, writeFileSync } from "node:fs";
const [command, ...args] = process.argv.slice(2);
const statePath = process.env.VCR_FIXTURE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const record = (effect) => {
  state.effects.push(effect);
  if (state.revokeAfter === effect) {
    state.run.status = "completed";
    state.run.conclusion = "cancelled";
  }
  save();
};
const output = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const fail = (message) => { console.error(message); process.exit(97); };
if (command === "gh") {
  if (args[0] !== "api") fail("Unexpected GitHub command");
  const endpoint = args[1];
  if (endpoint === ${JSON.stringify(`repos/openclaw/openclaw/git/ref/tags/${toolingTag}`)}) {
    output({ ref: ${JSON.stringify(`refs/tags/${toolingTag}`)}, object: { type: "commit", sha: state.tagSha } });
  } else if (endpoint === ${JSON.stringify(`repos/openclaw/openclaw/compare/${toolingSha}...main`)}) {
    output({ status: state.comparisonStatus });
  } else if (endpoint === "repos/openclaw/openclaw/actions/runs/67890") {
    if (state.unreadableRun) fail("HTTP 404: workflow run unavailable");
    output(state.run);
  } else fail("Unexpected GitHub endpoint: " + endpoint);
} else if (command === "docker") {
  if (args[0] !== "buildx" || args[1] !== "imagetools") fail("Unexpected Docker command");
  if (args[2] === "create") {
    const tags = args.flatMap((arg, index) => arg === "--tag" ? [args[index + 1]] : []);
    record("create:" + tags.join(","));
  } else if (args[2] === "inspect") {
    const ref = args[3] === "--raw" ? args[4] : args[3];
    if (args.at(-1).includes(".Image")) {
      output(${JSON.stringify(imageConfig("2026.7.2"))});
    } else if (ref.startsWith(${JSON.stringify(sourceImage)})) {
      const raw = ${JSON.stringify(rawManifests)}[ref];
      if (!args.includes("--raw") || raw === undefined) fail("Unexpected source inspection: " + ref);
      output(raw);
    } else if (ref.startsWith(${JSON.stringify(targetImage)})) {
      const browser = ref.includes("-browser");
      const armDigest = browser ? ${JSON.stringify(browserArm64Digest)} : ${JSON.stringify(arm64Digest)};
      if (args.includes("--raw")) {
        output(browser ? ${JSON.stringify(indexManifest(["amd64", "arm64"], false, browserArm64Digest))} : ${JSON.stringify(indexManifest(["amd64", "arm64"], false))});
      } else {
        const arch = ref.endsWith("-amd64") || ref.endsWith("-arm64");
        output({
          digest: arch ? (ref.endsWith("-arm64") ? armDigest : ${JSON.stringify(amd64Digest)}) : ${JSON.stringify(cleanIndexDigest)},
          mediaType: arch ? ${JSON.stringify(imageManifestMediaType)} : ${JSON.stringify(imageIndexMediaType)},
        });
      }
    } else fail("Unexpected target inspection: " + ref);
  } else fail("Unexpected imagetools command");
} else if (command === "vercel") {
  if (args.slice(0, 3).join(" ") !== "vcr login docker") fail("Unexpected Vercel command");
  record("login");
} else if (command === "sandbox") {
  if (args[0] !== "run" || !args.includes("--rm")) fail("Unexpected Sandbox command");
  record("sandbox");
  if (state.sandboxNotReady && state.effects.filter((effect) => effect === "sandbox").length === 1) {
    console.error("image_not_ready");
    process.exit(1);
  }
} else if (command !== "sleep") fail("Unexpected external command: " + command);
`,
  );
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const command of ["gh", "docker", "vercel", "sandbox", "sleep"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(commandFixture)} ${shellQuote(command)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    GH_TOKEN: "synthetic-token",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_SHA: toolingSha,
    GITHUB_REF_NAME: ref,
    GITHUB_REF: fullRef,
    GITHUB_RUN_ID: "67890",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_WORKFLOW_REF: `openclaw/openclaw/${workflowPath}@${fullRef}`,
    GITHUB_ENV: join(directory, "github-env"),
    GITHUB_OUTPUT: join(directory, "github-output"),
    VCR_ADVISORY: String(!manual),
    VCR_TOOLING_SHA: toolingSha,
    VCR_TOOLING_REF: ref,
    VCR_TOOLING_FULL_REF: fullRef,
    VCR_WRITER_RUN_ID: "67890",
    VCR_WRITER_RUN_ATTEMPT: "2",
    VCR_WRITER_WORKFLOW_PATH: workflowPath,
    TOOLING_SHA: manual ? "" : toolingSha,
    TOOLING_REF: manual ? "" : ref,
    TOOLING_FULL_REF: manual ? "" : fullRef,
    RELEASE_PUBLISH_RUN_ID: manual ? "" : "67890",
    RELEASE_PUBLISH_RUN_ATTEMPT: manual ? "" : "2",
    VCR_FIXTURE_STATE: statePath,
    VERCEL_CLI: join(bin, "vercel"),
    SANDBOX_CLI: join(bin, "sandbox"),
    VERCEL_PROJECT_ID: "synthetic-project",
    VERCEL_SCOPE: "synthetic-team",
    VERCEL_TOKEN: "synthetic-token",
    VERCEL_AUTH_TOKEN: "synthetic-token",
    VERCEL_VCR_IMAGE: targetImage,
    INCLUDE_BROWSER: "true",
    SOURCE_DIGESTS: `default=${defaultSourceDigest}\nslim=${slimSourceDigest}\nbrowser=${browserSourceDigest}`,
    SOURCE_IMAGE: sourceImage,
    TARGET_IMAGE: targetImage,
    VERSION: "2026.7.2",
  };
  const readState = () => JSON.parse(readFileSync(statePath, "utf8")) as AuthorityFixtureState;
  const job = requireJob(readWorkflow(vcrWorkflowPath), "publish");
  return {
    env,
    readState,
    update(patch: Partial<AuthorityFixtureState>) {
      writeFileSync(statePath, JSON.stringify({ ...readState(), ...patch }));
    },
    runStep(name: string) {
      const step = job.steps?.find((candidate) => candidate.name === name);
      if (!step?.run) {
        throw new Error(`Missing workflow shell step: ${name}`);
      }
      return spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", step.run], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
    },
    runCli(promote = false) {
      return spawnSync(
        process.execPath,
        [
          resolve("scripts/vercel-container-registry-publish.mjs"),
          "--version",
          "2026.7.2",
          "--target-image",
          targetImage,
          "--include-browser",
          ...(promote
            ? ["--promote-aliases"]
            : immutableSourceRefs.flatMap((sourceRef) => ["--source-ref", sourceRef])),
        ],
        { env, encoding: "utf8", timeout: 20_000 },
      );
    },
  };
}

// These shell fixtures exercise the Linux release runner's external effect boundaries.
describe.skipIf(process.platform !== "linux")(
  "VCR writer authority at external effect boundaries",
  () => {
    it.each(["automatic", "manual"] as const)(
      "publishes through the active %s workflow",
      (route) => {
        const fixture = authorityFixture(route);
        for (const name of Object.keys(fixture.env)) {
          if (name.startsWith("VCR_TOOLING_") || name.startsWith("VCR_WRITER_")) {
            delete fixture.env[name];
          }
        }
        const binding = fixture.runStep("Bind trusted registry tooling");
        expect(binding.status, binding.stderr).toBe(0);
        expect(readFileSync(fixture.env.GITHUB_OUTPUT!, "utf8")).toBe(`sha=${toolingSha}\n`);
        const boundEnv = Object.fromEntries(
          readFileSync(fixture.env.GITHUB_ENV!, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        Object.assign(fixture.env, boundEnv);
        for (const name of [
          "Authenticate Docker to Vercel Container Registry",
          "Copy and verify immutable release images",
          "Run custom-image Sandbox smoke",
          "Promote and verify channel aliases",
        ]) {
          const result = fixture.runStep(name);
          expect(result.status, `${name}: ${result.stderr}`).toBe(0);
        }
        expect(fixture.readState().effects).toEqual([
          "login",
          ...immutableWrites,
          "sandbox",
          ...aliasWrites,
        ]);
      },
    );

    it("allows automatic main tooling that remains an ancestor after main advances", () => {
      const fixture = authorityFixture("automatic-main");
      const result = fixture.runStep("Authenticate Docker to Vercel Container Registry");
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.readState().effects).toEqual(["login"]);
    });

    it("rechecks authority after setup before credential login", () => {
      const fixture = authorityFixture();
      expect(fixture.runStep("Validate Vercel Container Registry configuration").status).toBe(0);
      fixture.update({
        run: { ...fixture.readState().run, status: "completed", conclusion: "cancelled" },
      });
      const result = fixture.runStep("Authenticate Docker to Vercel Container Registry");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release workflow run status");
      expect(fixture.readState().effects).toEqual([]);
    });

    it.each([
      ["index to architecture", false, immutableWrites[0]!, immutableWrites.slice(0, 1)],
      ["between architectures", false, immutableWrites[1]!, immutableWrites.slice(0, 2)],
      ["between variants", false, immutableWrites[2]!, immutableWrites.slice(0, 3)],
      ["between aliases", true, aliasWrites[0]!, aliasWrites.slice(0, 1)],
    ] as const)(
      "stops the real publisher CLI when revoked %s",
      (_name, promote, revokeAfter, expected) => {
        const fixture = authorityFixture();
        fixture.update({ revokeAfter });
        const result = fixture.runCli(promote);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("release workflow run status");
        expect(fixture.readState().effects).toEqual(expected);
      },
    );

    it("rechecks authority before retrying Sandbox acquisition", () => {
      const fixture = authorityFixture();
      fixture.update({ revokeAfter: "sandbox", sandboxNotReady: true });
      const result = fixture.runStep("Run custom-image Sandbox smoke");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("image_not_ready");
      expect(result.stderr).toContain("release workflow run status");
      expect(fixture.readState().effects).toEqual(["sandbox"]);
    });

    it("retries an unready Sandbox image while writer authority remains active", () => {
      const fixture = authorityFixture();
      fixture.update({ sandboxNotReady: true });
      const result = fixture.runStep("Run custom-image Sandbox smoke");
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.readState().effects).toEqual(["sandbox", "sandbox"]);
    });

    it("does not promote aliases after authority is revoked by a successful Sandbox acquisition", () => {
      const fixture = authorityFixture("manual");
      fixture.update({ revokeAfter: "sandbox" });
      const smoke = fixture.runStep("Run custom-image Sandbox smoke");
      expect(smoke.status, smoke.stderr).toBe(0);
      const promote = fixture.runStep("Promote and verify channel aliases");
      expect(promote.status).toBe(1);
      expect(promote.stderr).toContain("release workflow run status");
      expect(fixture.readState().effects).toEqual(["sandbox"]);
    });

    // Canonical identity tests own the full validation matrix. These cases prove
    // that VCR actually applies that contract at its credential boundary.
    it.each([
      ["wrong run", { id: 67891 }, "runId"],
      ["stale attempt", { run_attempt: 3 }, "runAttempt"],
      ["wrong workflow", { path: vcrWorkflowPath }, "workflowPath"],
      ["wrong ref", { head_branch: "main" }, "headBranch"],
      ["completed success", { status: "completed", conclusion: "success" }, "status"],
      ["completed failure", { status: "completed", conclusion: "failure" }, "status"],
    ] as const)("rejects %s before login", (_name, runPatch, diagnostic) => {
      const fixture = authorityFixture();
      fixture.update({ run: { ...fixture.readState().run, ...runPatch } });
      const result = fixture.runStep("Authenticate Docker to Vercel Container Registry");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`release workflow run ${diagnostic}`);
      expect(fixture.readState().effects).toEqual([]);
    });

    it.each([
      ["moved tooling tag", { tagSha: "d".repeat(40) }, "protected release tooling tag"],
      ["unreadable writer", { unreadableRun: true }, "HTTP 404"],
    ] as const)("rejects %s before login", (_name, patch, diagnostic) => {
      const fixture = authorityFixture();
      fixture.update(patch);
      const result = fixture.runStep("Authenticate Docker to Vercel Container Registry");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
      expect(fixture.readState().effects).toEqual([]);
    });

    it.each([
      ["missing tooling SHA", "TOOLING_SHA", ""],
      ["missing parent attempt", "RELEASE_PUBLISH_RUN_ATTEMPT", ""],
      ["different parent", "RELEASE_PUBLISH_RUN_ID", "67891"],
      ["different tooling ref", "TOOLING_FULL_REF", "refs/heads/main"],
    ])("rejects %s before checkout", (_name, name, value) => {
      const fixture = authorityFixture();
      fixture.env[name] = value;
      const result = fixture.runStep("Bind trusted registry tooling");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::");
      expect(fixture.readState().effects).toEqual([]);
    });

    it("requires a complete binding for direct publisher CLI invocation", () => {
      const fixture = authorityFixture();
      delete fixture.env.VCR_WRITER_RUN_ATTEMPT;
      const result = fixture.runCli();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("complete executing workflow identity");
      expect(fixture.readState().effects).toEqual([]);
    });

    it.each([
      ["non-main dispatch", "GITHUB_REF", "refs/heads/release/2026.7.2"],
      ["historical parent", "RELEASE_PUBLISH_RUN_ID", "12345"],
    ])("rejects manual recovery with %s", (_name, name, value) => {
      const fixture = authorityFixture("manual");
      fixture.env[name] = value;
      const result = fixture.runStep("Bind trusted registry tooling");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("recovery requires its own main-branch workflow dispatch");
      expect(fixture.readState().effects).toEqual([]);
    });
  },
);

describe("Vercel Container Registry publishing", () => {
  it.each([
    ["extended-stable", "2026.6.33"],
    ["beta", "2026.7.2-beta.1"],
  ])("plans the full immutable %s image set", (channel, version) => {
    const plan = createVercelContainerRegistryPublishPlan({
      includeBrowser: true,
      sourceImage,
      targetImage,
      version,
    });

    expect(plan.channel).toBe(channel);
    expect(plan.readinessTags).toEqual([version, `${version}-slim`, `${version}-browser`]);
    expect(plan.copies.map((copy) => copy.targetTag)).toEqual([
      version,
      `${version}-amd64`,
      `${version}-arm64`,
      `${version}-slim`,
      `${version}-slim-amd64`,
      `${version}-slim-arm64`,
      `${version}-browser`,
      `${version}-browser-amd64`,
      `${version}-browser-arm64`,
    ]);
  });

  it("admits the observed release node_modules layer that the former 500 MB cap rejected", () => {
    const calls: string[][] = [];
    const manifest = platformManifest();
    const observedDigest =
      "sha256:87a84edfc11732d9ef1ca5a598a871ce3f4b7572dd3213dc5107d519d9ab61c0";
    manifest.layers = Array.from({ length: 11 }, (_, index) => ({
      ...manifest.layers[0]!,
      digest: index === 10 ? observedDigest : layerDigest,
      size: index === 10 ? 869_561_235 : 1024,
    }));
    const execFileSyncImpl = successfulExecutor(calls, {
      rawManifests: { [`${sourceImage}@${amd64Digest}`]: JSON.stringify(manifest) },
      version: "2026.9.6",
    });

    publishVercelContainerRegistryImages(publishParams("2026.9.6", true), {
      execFileSyncImpl,
      beforeMutation: () => undefined,
      log: () => {},
    });

    expect(calls.filter((args) => args[2] === "create")).toHaveLength(9);
  });

  it("admits every selection before copying even when only the last platform exceeds a cap", () => {
    const manifest = platformManifest();
    manifest.layers[0]!.size = 2_000_000_001;
    const { calls, publish } = admissionFixture(JSON.stringify(manifest), {
      digest: browserArm64Digest,
    });

    expect(publish).toThrow(
      `browser/2026.7.2-browser linux/arm64 ${sourceImage}@${browserArm64Digest}: layer[0] ${layerDigest} is 2000000001 bytes; client cap 2000000000 bytes`,
    );
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(0);
  });

  it("rejects invalid layer[0] size 0.5 before copying", () => {
    const { field, size } = { field: "layer[0]", size: 0.5 };

    const manifest = platformManifest();
    const raw = JSON.stringify({
      ...manifest,
      layers: [{ ...manifest.layers[0], size }],
    });
    const { calls, publish } = admissionFixture(raw);

    expect(publish).toThrow(
      `default/2026.7.2 linux/amd64 ${sourceImage}@${amd64Digest}: ${field}.size must be a nonnegative safe integer byte count`,
    );
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(0);
  });

  it.each([
    ["non-array layers", { ...platformManifest(), layers: {} }, "layers"],
    ["null layer", { ...platformManifest(), layers: [null] }, "layer[0]"],
    ["unsupported schema", { ...platformManifest(), schemaVersion: 1 }, "image manifest"],
  ] as const)("rejects %s before copying", (_name, manifest, diagnostic) => {
    const { calls, publish } = admissionFixture(JSON.stringify(manifest));
    const execute = vi.fn(publish);

    expect(execute).toThrow(
      `VCR preflight: default/2026.7.2 linux/amd64 ${sourceImage}@${amd64Digest}:`,
    );
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(0);
    expect(execute.mock.results[0]?.value).toHaveProperty(
      "message",
      expect.stringContaining(diagnostic),
    );
  });

  it.each([
    ["invalid JSON", "{", "Invalid platform manifest JSON."],
    ["inspect failure", new Error("Manifest fetch failed"), "Could not inspect platform manifest."],
  ] as const)("rejects %s with selection context before copying", (_name, raw, diagnostic) => {
    const { calls, publish } = admissionFixture(raw);

    expect(publish).toThrow(
      `VCR preflight: default/2026.7.2 linux/amd64 ${sourceImage}@${amd64Digest}: ${diagnostic} No images copied.`,
    );
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(0);
  });

  it("rejects an unattested immutable source before any registry write", () => {
    const calls: string[][] = [];
    const unattestedSourceRef = `${sourceImage}@${browserSourceDigest}`;
    const execFileSyncImpl = successfulExecutor(calls, { unattestedSourceRef });

    expect(() =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        beforeMutation: () => undefined,
        log: () => {},
      }),
    ).toThrow(`${unattestedSourceRef}: missing attestation manifest for linux/amd64`);
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("rejects attested source label custom-build at the requested-release comparison", () => {
    const sourceVersion = "custom-build";

    const calls: string[][] = [];
    const mismatchedSourceRef = `${sourceImage}@${browserSourceDigest}`;
    const execFileSyncImpl = successfulExecutor(calls, {
      sourceVersions: { [mismatchedSourceRef]: sourceVersion },
    });

    expect(() =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        beforeMutation: () => undefined,
        log: () => {},
      }),
    ).toThrow(`${mismatchedSourceRef} reports version ${sourceVersion}, expected 2026.7.2`);
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it.each([
    ["malformed JSON", "{", "linux/amd64"],
    ["second-platform missing label", "{}", "linux/arm64"],
  ])("rejects %s before copying an attested source", (_name, raw, platform) => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls, {
      sourceImageConfigs: { [platform]: raw },
    });
    const publish = vi.fn(() =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        beforeMutation: () => undefined,
        log: () => {},
      }),
    );
    const sourceRef = `${sourceImage}@${defaultSourceDigest}`;

    expect(publish).toThrow(
      raw === "{"
        ? `Could not parse the ${platform} image config for ${sourceRef}.`
        : `${sourceRef} does not have an org.opencontainers.image.version label for ${platform}.`,
    );
    if (raw === "{") {
      expect(publish.mock.results[0]?.value).toHaveProperty("cause", expect.any(SyntaxError));
    } else {
      expect(publish.mock.results[0]?.value).not.toHaveProperty("cause");
    }
    expect(calls.at(-1)).toEqual([
      "buildx",
      "imagetools",
      "inspect",
      sourceRef,
      "--format",
      `{{json (index .Image "${platform}")}}`,
    ]);
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when VCR does not preserve a source platform manifest digest", () => {
    const calls: string[][] = [];
    const changedTargetRef = `${targetImage}:2026.7.2-amd64`;
    const execFileSyncImpl = successfulExecutor(calls, { changedTargetRef });

    expect(() =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        beforeMutation: () => undefined,
        log: () => {},
      }),
    ).toThrow(`${changedTargetRef} resolved to ${changedDigest}, expected ${amd64Digest}`);
  });

  it("requires every selected source variant to be an immutable digest ref", () => {
    expect(() =>
      publishVercelContainerRegistryImages(
        {
          ...publishParams("2026.7.2", true),
          sourceRefs: [
            `default=${sourceImage}:2026.7.2`,
            `slim=${sourceImage}@${slimSourceDigest}`,
            `browser=${sourceImage}@${browserSourceDigest}`,
          ],
        },
        { execFileSyncImpl: vi.fn(), beforeMutation: () => undefined, log: () => {} },
      ),
    ).toThrow("untagged container image name");

    expect(() =>
      publishVercelContainerRegistryImages(
        {
          ...publishParams("2026.7.2", true),
          sourceRefs: immutableSourceRefs.slice(0, 2),
        },
        { execFileSyncImpl: vi.fn(), beforeMutation: () => undefined, log: () => {} },
      ),
    ).toThrow("Missing immutable VCR source ref for browser");
  });

  it("promotes VCR aliases from the verified clean indexes", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls);

    publishVercelContainerRegistryImages(publishParams("2026.7.2", false), {
      execFileSyncImpl,
      beforeMutation: () => undefined,
      log: () => {},
    });
    promoteVercelContainerRegistryAliases(
      {
        includeBrowser: false,
        targetImage,
        version: "2026.7.2",
      },
      { execFileSyncImpl, beforeMutation: () => undefined, log: () => {} },
    );

    expect(calls.filter((args) => args[2] === "create").slice(-2)).toEqual([
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        `${targetImage}:latest`,
        "--tag",
        `${targetImage}:main`,
        `${targetImage}@${cleanIndexDigest}`,
      ],
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        `${targetImage}:slim`,
        "--tag",
        `${targetImage}:main-slim`,
        `${targetImage}@${cleanIndexDigest}`,
      ],
    ]);
  });

  it("refuses to move a VCR channel alias backward", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls, {
      currentAliasVersion: "2026.7.3",
    });

    expect(() =>
      promoteVercelContainerRegistryAliases(
        {
          includeBrowser: false,
          targetImage,
          version: "2026.7.2",
        },
        { execFileSyncImpl, beforeMutation: () => undefined, log: () => {} },
      ),
    ).toThrow(`Refusing to move ${targetImage}:latest backward from 2026.7.3 to 2026.7.2`);
    expect(
      calls.some((args) => args[2] === "create" && args.includes(`${targetImage}:latest`)),
    ).toBe(false);
  });

  it("allows a first VCR alias publication when the exact target ref is absent", () => {
    const calls: string[][] = [];
    const execute = successfulExecutor(calls);
    let created = false;
    const execFileSyncImpl = vi.fn((command: string, args: string[]) => {
      if (args[2] === "create") {
        created = true;
      } else if (args.at(-1)?.includes(".Image") && !args[3]!.includes("@") && !created) {
        const error = new Error("docker inspect failed");
        Object.assign(error, { stderr: `ERROR: ${args[3]}: not found` });
        throw error;
      }
      return execute(command, args);
    });

    promoteVercelContainerRegistryAliases(
      {
        includeBrowser: false,
        targetImage,
        version: "2026.7.2",
      },
      { execFileSyncImpl, beforeMutation: () => undefined, log: () => {} },
    );

    expect(calls.filter((args) => args[2] === "create")).toHaveLength(2);
  });

  it("transports only secret-safe digests across the VCR workflow boundary", () => {
    const dockerRelease = readWorkflow(".github/workflows/docker-release.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/openclaw-release-publish.yml");
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const dockerPublish = requireJob(dockerRelease, "publish");
    const releasePublish = requireJob(releaseWorkflow, "publish_vcr");
    const reusablePublish = requireJob(reusable, "publish");

    expect(dockerPublish.outputs?.vcr_source_digests).toBe(
      "${{ steps.promote.outputs.vcr_source_digests }}",
    );
    expect(dockerRelease.on?.workflow_call?.outputs?.vcr_source_digests?.value).toBe(
      "${{ jobs.publish.outputs.vcr_source_digests }}",
    );

    expect(releasePublish.with?.source_digests).toBe(
      "${{ needs.publish_docker.outputs.vcr_source_digests }}",
    );
    expect(releasePublish.with).toMatchObject({
      tooling_sha: "${{ github.workflow_sha }}",
      tooling_ref: "${{ github.ref_name }}",
      tooling_full_ref: "${{ github.ref }}",
      release_publish_run_id: "${{ github.run_id }}",
      release_publish_run_attempt: "${{ github.run_attempt }}",
    });
    expect(releasePublish.permissions).toEqual({ actions: "read", contents: "read" });
    for (const name of [
      "tooling_sha",
      "tooling_ref",
      "tooling_full_ref",
      "release_publish_run_id",
      "release_publish_run_attempt",
    ]) {
      expect(reusable.on?.workflow_call?.inputs?.[name]).toMatchObject({
        required: true,
        type: "string",
      });
    }
    expect(reusablePublish.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      VCR_ADVISORY: "${{ inputs.advisory == true }}",
    });
    expect(reusablePublish.steps?.[0]).toMatchObject({
      id: "tooling",
      env: {
        TOOLING_SHA: "${{ inputs.tooling_sha }}",
        TOOLING_REF: "${{ inputs.tooling_ref }}",
        TOOLING_FULL_REF: "${{ inputs.tooling_full_ref }}",
        RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
        RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
      },
    });
    expect(reusablePublish.steps?.[1]).toMatchObject({
      name: "Checkout trusted registry tooling",
      with: { ref: "${{ steps.tooling.outputs.sha }}", "persist-credentials": false },
    });
    expect(reusable.on?.workflow_call?.inputs?.source_digests).toEqual({
      description: "Newline-delimited alias=sha256:<64 lowercase hex> entries",
      required: true,
      type: "string",
    });
    const copyStep = reusablePublish.steps?.find(
      (step) => step.name === "Copy and verify immutable release images",
    );
    expect(copyStep?.env).toMatchObject({
      SOURCE_DIGESTS: "${{ inputs.source_digests }}",
      SOURCE_IMAGE: "ghcr.io/${{ github.repository }}",
    });
    expect(copyStep?.env).not.toHaveProperty("SOURCE_REFS");
    expect(copyStep?.run).toContain("${alias}=${SOURCE_IMAGE}@${digest}");
  });

  it("keeps direct VCR recovery blocking without exposing an advisory dispatch input", () => {
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/openclaw-release-publish.yml");

    expect(reusable.on?.workflow_dispatch?.inputs).not.toHaveProperty("advisory");
    expect(requireJob(reusable, "publish")["continue-on-error"]).toBe(
      "${{ inputs.advisory == true }}",
    );
    expect(requireJob(releaseWorkflow, "publish_vcr").with?.advisory).toBe(true);
  });

  it("isolates best-effort VCR publication from Docker and GitHub release finalization", () => {
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const dockerRelease = readWorkflow(".github/workflows/docker-release.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/openclaw-release-publish.yml");
    const manualPromotion = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const recoveryValidation = requireJob(reusable, "validate_recovery");
    const recoveryApproval = requireJob(reusable, "approve_recovery");
    const reusablePublish = requireJob(reusable, "publish");
    const releasePublish = requireJob(releaseWorkflow, "publish_vcr");
    const finalizeRelease = requireJob(releaseWorkflow, "finalize_github_release");
    const manualResolve = requireJob(manualPromotion, "resolve");
    const manualApproval = requireJob(manualPromotion, "approve");

    expect(requireJob(dockerRelease, "publish").concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(reusable.concurrency).toEqual({
      group: "vcr-release-publish",
      "cancel-in-progress": false,
    });
    expect(dockerRelease.jobs?.["publish-vcr"]).toBeUndefined();
    expect(releasePublish.needs).toEqual(["publish_docker"]);
    expect(releasePublish.if).not.toContain("beta");
    expect(releasePublish.uses).toBe("./.github/workflows/vercel-container-registry-publish.yml");
    expect(releasePublish.with).toMatchObject({
      advisory: true,
      include_browser: "${{ needs.publish_docker.outputs.include_browser == 'true' }}",
      version: "${{ needs.publish_docker.outputs.version }}",
    });
    expect(releasePublish.secrets).toEqual({
      VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
    });
    expect(finalizeRelease.needs).toEqual([
      "publish",
      "publish_docker",
      "approve_github_release",
      "finalize_github_release_before_docker",
    ]);
    expect(finalizeRelease.if).not.toContain("publish_vcr");
    expect(recoveryValidation.if).toBe("${{ !inputs.advisory }}");
    expect(recoveryValidation.permissions).toEqual({});
    expect(recoveryValidation.environment).toBeUndefined();
    expect(recoveryValidation.secrets).toBeUndefined();
    const validateRecoveryStep = recoveryValidation.steps?.find(
      (step) => step.name === "Require a main-branch recovery dispatch",
    );
    expect(validateRecoveryStep?.env).toEqual({ WORKFLOW_REF: "${{ github.ref }}" });
    expect(validateRecoveryStep?.run).toContain('"${WORKFLOW_REF}" != "refs/heads/main"');
    expect(validateRecoveryStep?.run).toContain(
      "::error::Vercel registry recovery must be dispatched from main",
    );
    expect(recoveryApproval.needs).toBe("validate_recovery");
    expect(recoveryApproval.if).toBe("${{ !inputs.advisory }}");
    expect(recoveryApproval.environment).toBe("docker-release");
    expect(recoveryApproval.permissions).toEqual({});
    expect(reusablePublish.needs).toEqual(["validate_recovery", "approve_recovery"]);
    expect(reusablePublish.if).toBe(
      "${{ always() && (inputs.advisory || (needs.validate_recovery.result == 'success' && needs.approve_recovery.result == 'success')) }}",
    );
    expect(reusablePublish.permissions).toEqual({ actions: "read", contents: "read" });
    expect(reusablePublish["timeout-minutes"]).toBe(30);

    const validateDispatch = manualResolve.steps?.find((step) =>
      step.name?.includes("main-branch dispatch"),
    );
    const resolvePolicy = manualResolve.steps?.find(
      (step) => step.name === "Resolve release channel policy",
    );
    expect(validateDispatch?.run).toContain('"${WORKFLOW_REF}" != "refs/heads/main"');
    expect(resolvePolicy?.run).toContain("Expected a final stable or extended-stable");
    expect(manualApproval.environment).toBe("docker-release");
    expect(JSON.stringify(manualPromotion)).not.toContain("VERCEL_TOKEN");
    expect(JSON.stringify(manualPromotion)).not.toContain("vercel-container-registry-publish.yml");

    const reusableCallers = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .filter((name) =>
        readFileSync(`.github/workflows/${name}`, "utf8").includes(
          "uses: ./.github/workflows/vercel-container-registry-publish.yml",
        ),
      );
    expect(reusableCallers).toEqual(["openclaw-release-publish.yml"]);
    expect(reusable.on?.workflow_call?.inputs?.advisory).toEqual({
      description: "Keep automated release mirroring non-blocking",
      required: true,
      type: "boolean",
    });
    expect(reusable.on?.workflow_call?.inputs?.include_browser).toEqual({
      description: "Whether the tagged Docker release includes browser images",
      required: true,
      type: "boolean",
    });
    expect(reusable.on?.workflow_dispatch?.inputs).toEqual({
      include_browser: reusable.on?.workflow_call?.inputs?.include_browser,
      source_digests: reusable.on?.workflow_call?.inputs?.source_digests,
      version: reusable.on?.workflow_call?.inputs?.version,
    });
    expect(reusablePublish.steps?.find((step) => step.name === "Set up Docker Builder")?.uses).toBe(
      "docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069",
    );
    const materializeVercel = reusablePublish.steps?.find(
      (step) => step.name === "Materialize locked Vercel CLI",
    );
    expect(materializeVercel?.run).toContain("scripts/materialize-vercel-cli.sh");
    const authenticateVercel = reusablePublish.steps?.find(
      (step) => step.name === "Authenticate Docker to Vercel Container Registry",
    );
    expect(authenticateVercel?.env?.VERCEL_CLI).toBe("${{ steps.vercel_cli.outputs.cli }}");
    expect(reusablePublish.steps?.indexOf(authenticateVercel!)).toBeGreaterThan(
      reusablePublish.steps?.indexOf(materializeVercel!) ?? -1,
    );
    expect(authenticateVercel?.run).toContain('"${VERCEL_CLI}" vcr login docker');
    expect(JSON.stringify(reusablePublish)).not.toContain("npx --yes");
    expect(JSON.stringify(reusablePublish)).not.toContain("docker-channel-promote.mjs");
    const copyIndex = reusablePublish.steps?.findIndex(
      (step) => step.name === "Copy and verify immutable release images",
    );
    const smokeIndex = reusablePublish.steps?.findIndex(
      (step) => step.name === "Run custom-image Sandbox smoke",
    );
    const promoteIndex = reusablePublish.steps?.findIndex(
      (step) => step.name === "Promote and verify channel aliases",
    );
    expect(copyIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(copyIndex ?? -1);
    expect(promoteIndex).toBeGreaterThan(smokeIndex ?? -1);
    const smokeStep = reusablePublish.steps?.[smokeIndex ?? -1];
    expect(smokeStep?.env?.SANDBOX_CLI).toBe("${{ steps.vercel_cli.outputs.sandbox_cli }}");
    const smokeRun = smokeStep?.run ?? "";
    expect(smokeRun).toContain('"${SANDBOX_CLI}" run \\\n');
    expect(smokeRun).toContain("image_not_ready");
    expect(smokeRun).toContain("retry_deadline");
  });

  it("pins the complete Vercel CLI dependency closure", () => {
    const packageJson = JSON.parse(
      readFileSync(".github/release/vercel-cli/package.json", "utf8"),
    ) as { dependencies?: Record<string, string> };
    const packageLockBytes = readFileSync(".github/release/vercel-cli/package-lock.json");
    const packageLock = JSON.parse(packageLockBytes.toString("utf8")) as {
      lockfileVersion?: number;
      packages?: Record<string, { integrity?: string; version?: string }>;
    };
    const materialize =
      readFileSync("scripts/materialize-vercel-cli.sh", "utf8") +
      readFileSync("scripts/lib/materialize-pinned-cli.sh", "utf8");

    expect(packageJson.dependencies).toEqual({ sandbox: "4.7.1", vercel: "63.1.0" });
    expect(packageLock.lockfileVersion).toBe(3);
    expect(packageLock.packages?.["node_modules/vercel"]).toMatchObject({
      integrity:
        "sha512-JQvJODfMeBGejhW1nfu0zfczU8I0NiARD3FilxuBjFeMtEzgK2LeBD6RC1yyhwR8mVQzod/p/SbjyDNFx11njQ==",
      version: "63.1.0",
    });
    expect(packageLock.packages?.["node_modules/sandbox"]).toMatchObject({
      bin: { sandbox: "bin/sandbox.mjs", sbx: "bin/sandbox.mjs" },
      integrity:
        "sha512-sAY15QFNGlHclRKl06CNjynENgacoHDFSJfaGxS8/JbBhsgqFv9SuHAMhGWI3sYX14317MH8B+gjzhhQiXVo9Q==",
      version: "4.7.1",
    });
    const lockSha256 = createHash("sha256").update(packageLockBytes).digest("hex");
    expect(materialize).toContain(`expected_lock_sha256="${lockSha256}"`);
    expect(materialize).toContain("npm ci \\\n");
    expect(materialize).toContain("--ignore-scripts");
    expect(materialize).toContain("additional_bin=sandbox_cli=sandbox");
    expect(materialize).toContain(
      'test -x "${destination}/node_modules/.bin/${additional_bin#*=}"',
    );
    expect(materialize).toContain(
      'echo "${additional_bin%%=*}=${destination}/node_modules/.bin/${additional_bin#*=}"',
    );
  });
});
