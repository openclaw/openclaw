import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createVercelContainerRegistryPublishPlan,
  promoteVercelContainerRegistryAliases,
  publishVercelContainerRegistryImages,
} from "../../scripts/vercel-container-registry-publish.mjs";

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

function aliasCommand(...tags: string[]) {
  return [
    "buildx",
    "imagetools",
    "create",
    "--prefer-index=false",
    ...tags.flatMap((tag) => ["--tag", `${targetImage}:${tag}`]),
    `${targetImage}@${cleanIndexDigest}`,
  ];
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

function registryFixture(
  options: Parameters<typeof successfulExecutor>[1] = {},
  includeBrowser = true,
) {
  const calls: string[][] = [];
  const execFileSyncImpl = successfulExecutor(calls, options);
  const params = publishParams(options.version ?? "2026.7.2", includeBrowser);
  const execution = { execFileSyncImpl, log: () => {} };
  return {
    calls,
    publish: () => publishVercelContainerRegistryImages(params, execution),
    promote: () => promoteVercelContainerRegistryAliases(params, execution),
  };
}

function admissionFixture(raw: string | Error, { digest = amd64Digest } = {}) {
  return registryFixture({ rawManifests: { [`${sourceImage}@${digest}`]: raw } });
}

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
    const manifest = platformManifest();
    const observedDigest =
      "sha256:87a84edfc11732d9ef1ca5a598a871ce3f4b7572dd3213dc5107d519d9ab61c0";
    manifest.layers = Array.from({ length: 11 }, (_, index) => ({
      ...manifest.layers[0]!,
      digest: index === 10 ? observedDigest : layerDigest,
      size: index === 10 ? 869_561_235 : 1024,
    }));
    const { calls, publish } = registryFixture({
      rawManifests: { [`${sourceImage}@${amd64Digest}`]: JSON.stringify(manifest) },
      version: "2026.9.6",
    });

    publish();

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
    const manifest = platformManifest();
    const raw = JSON.stringify({
      ...manifest,
      layers: [{ ...manifest.layers[0], size: 0.5 }],
    });
    const { calls, publish } = admissionFixture(raw);

    expect(publish).toThrow(
      `default/2026.7.2 linux/amd64 ${sourceImage}@${amd64Digest}: layer[0].size must be a nonnegative safe integer byte count`,
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
    const unattestedSourceRef = `${sourceImage}@${browserSourceDigest}`;
    const { calls, publish } = registryFixture({ unattestedSourceRef });

    expect(publish).toThrow(`${unattestedSourceRef}: missing attestation manifest for linux/amd64`);
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("rejects attested source label custom-build at the requested-release comparison", () => {
    const sourceVersion = "custom-build";

    const mismatchedSourceRef = `${sourceImage}@${browserSourceDigest}`;
    const { calls, publish } = registryFixture({
      sourceVersions: { [mismatchedSourceRef]: sourceVersion },
    });

    expect(publish).toThrow(
      `${mismatchedSourceRef} reports version ${sourceVersion}, expected 2026.7.2`,
    );
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it.each([
    ["malformed JSON", "{", "linux/amd64"],
    ["second-platform missing label", "{}", "linux/arm64"],
  ])("rejects %s before copying an attested source", (_name, raw, platform) => {
    const fixture = registryFixture({
      sourceImageConfigs: { [platform]: raw },
    });
    const { calls } = fixture;
    const publish = vi.fn(fixture.publish);
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
    const changedTargetRef = `${targetImage}:2026.7.2-amd64`;
    const { publish } = registryFixture({ changedTargetRef });

    expect(publish).toThrow(
      `${changedTargetRef} resolved to ${changedDigest}, expected ${amd64Digest}`,
    );
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
        { execFileSyncImpl: vi.fn(), log: () => {} },
      ),
    ).toThrow("untagged container image name");

    expect(() =>
      publishVercelContainerRegistryImages(
        {
          ...publishParams("2026.7.2", true),
          sourceRefs: immutableSourceRefs.slice(0, 2),
        },
        { execFileSyncImpl: vi.fn(), log: () => {} },
      ),
    ).toThrow("Missing immutable VCR source ref for browser");
  });

  it("promotes VCR aliases from the verified clean indexes", () => {
    const { calls, publish, promote } = registryFixture({}, false);
    publish();
    promote();

    expect(calls.filter((args) => args[2] === "create").slice(-2)).toEqual([
      aliasCommand("latest", "main"),
      aliasCommand("slim", "main-slim"),
    ]);
  });

  it("refuses to move a VCR channel alias backward", () => {
    const { calls, promote } = registryFixture(
      {
        currentAliasVersion: "2026.7.3",
      },
      false,
    );

    expect(promote).toThrow(
      `Refusing to move ${targetImage}:latest backward from 2026.7.3 to 2026.7.2`,
    );
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
      { execFileSyncImpl, log: () => {} },
    );

    expect(calls.filter((args) => args[2] === "create")).toHaveLength(2);
  });

  it("keeps cross-registry readback inside the advisory mirror and blocking recovery", () => {
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const release = readWorkflow(".github/workflows/openclaw-release-publish.yml");
    const docker = readWorkflow(".github/workflows/docker-release.yml");
    const publish = requireJob(reusable, "publish");
    const releaseMirror = requireJob(release, "publish_vcr");
    const finalize = requireJob(release, "finalize_github_release");

    expect(requireJob(docker, "publish").outputs?.vcr_source_digests).toBe(
      "${{ steps.promote.outputs.vcr_source_digests }}",
    );
    expect(releaseMirror).toMatchObject({
      needs: ["publish_docker"],
      uses: "./.github/workflows/vercel-container-registry-publish.yml",
      with: {
        advisory: true,
        include_browser: "${{ needs.publish_docker.outputs.include_browser == 'true' }}",
        source_digests: "${{ needs.publish_docker.outputs.vcr_source_digests }}",
        version: "${{ needs.publish_docker.outputs.version }}",
      },
    });
    expect(finalize.needs).not.toContain("publish_vcr");
    expect(requireJob(reusable, "approve_recovery")).toMatchObject({
      environment: "docker-release",
      if: "${{ !inputs.advisory }}",
      needs: "validate_recovery",
    });
    expect(publish["continue-on-error"]).toBe("${{ inputs.advisory == true }}");

    const steps = publish.steps ?? [];
    const stepIndex = (name: string) => steps.findIndex((step) => step.name === name);
    const login = stepIndex("Authenticate Docker to Vercel Container Registry");
    const promote = stepIndex("Promote and verify channel aliases");
    const readback = stepIndex("Verify complete cross-registry readback");
    expect(login).toBeGreaterThan(-1);
    expect(readback).toBeGreaterThan(promote);
    const command = steps[readback]?.run;
    expect(command).toContain("scripts/container-registry-readback.mjs");
    expect(command).toContain('--docker-image "ghcr.io/${GITHUB_REPOSITORY}"');
    expect(command).toContain('--docker-image "docker.io/openclaw/openclaw"');
    expect(command).toContain('--vercel-image "${TARGET_IMAGE}"');
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

    expect(packageJson.dependencies).toEqual({ sandbox: "4.11.1", vercel: "65.2.0" });
    expect(packageLock.lockfileVersion).toBe(3);
    expect(packageLock.packages?.["node_modules/vercel"]).toMatchObject({
      integrity:
        "sha512-IPalObt3xnaY9Njbwb3wbQR7ht0gyL3XYt4z1wjFui3r5pkJPKSAGaGSD4B5AX5B4tOXxSbnXpWnKx+RJgdKrg==",
      version: "65.2.0",
    });
    expect(packageLock.packages?.["node_modules/sandbox"]).toMatchObject({
      bin: { sandbox: "bin/sandbox.mjs", sbx: "bin/sandbox.mjs" },
      integrity:
        "sha512-TRjMwPjn7lKQculAXJ9rmv73jQ+9+5Hr2L5KMm1HfQiDhDXgO0pZACiy5ExtSzRW6mZgTGniWmWslhOu77DQdA==",
      version: "4.11.1",
    });
    expect(packageLock.packages?.["node_modules/fast-uri"]?.version).toBe("3.1.9");
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
