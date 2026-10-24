import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFullReleaseCandidateRequest,
  candidateRequestSha256,
  canonicalFullReleaseCandidateRequestJson,
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateRequest,
} from "../../scripts/full-release-candidate-contract.mjs";
import {
  candidateArtifactJsonFromBinding,
  resolveCandidateBinding,
} from "../../scripts/lib/full-release-candidate-reuse.mjs";
import {
  canonicalTestJson,
  canonicalTestSha256,
  fullReleaseCandidateArtifact,
  fullReleaseCandidateBindingFixture,
  fullReleaseCandidateManifestFixture,
  fullReleaseCandidateRequestInput,
} from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/full-release-candidate-contract.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Golden v3 request bytes bind the selected baseline and complete effective inventory.
const CANONICAL_REQUEST_JSON =
  '{"allowFrozenTargetScenarioOmissions":false,"allowUnreleasedChangelog":false,"contractVersions":{"package":1,"prepublishPluginRegistry":1,"sharedImage":1},"packagePublished":false,"releaseProfile":"stable","releaseSoak":true,"repository":"openclaw/openclaw","schema":"openclaw.full-release-candidate-request/v3","sharedImagePolicy":"no-push-artifact","targetSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","toolingSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","upgradeBaseline":"openclaw@latest","upgradeSurvivorBaselines":["openclaw@latest"],"upgradeSurvivorScenarios":["acpx-openclaw-tools-bridge","base","bootstrap-persona","channel-post-core-restore","configured-plugin-installs","cron-scheduled-authority","custom-plugin-siblings","feishu-channel","legacy-operator-state","meeting-transcripts-sqlite","package-publication-recovery","package-stranded-first-hop","package-verification-recovery","plugin-deps-cleanup","stale-source-plugin-shadow","tilde-log-path","versioned-runtime-deps"]}\n';
const CANONICAL_REQUEST_SHA256 = "bfba3b9d365762629f86c676486a21c65d8de2dc8e0e56238051685e5ddf6b82";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    ...fullReleaseCandidateManifestFixture(),
    ...overrides,
  };
}

function runContract(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runManifestContract(value: unknown) {
  return runJsonContract("manifest", value).result;
}

function runJsonContract(command: string, value: unknown) {
  const root = tempDirs.make("full-release-candidate-manifest-");
  const input = join(root, "input.json");
  const output = join(root, "output.json");
  writeFileSync(input, JSON.stringify(value));
  return { result: runContract([command, "--input", input, "--output", output]), output };
}

type CandidateBindingFixture = ReturnType<typeof fullReleaseCandidateBindingFixture>;
const COUNTERFEIT_WORKFLOW = ".github/workflows/candidate-evidence-test.yml";
const LATER_EXPIRY = "2026-09-05T12:00:00Z";

function setBindingAttempt(
  binding: CandidateBindingFixture,
  attempt: Partial<Pick<CandidateBindingFixture["producer"], "runId" | "runAttempt">>,
) {
  for (const participant of [
    binding.producer,
    binding.publisher,
    binding.package.artifact,
    binding.prepublishPluginRegistry.artifact,
    binding.sharedImage.artifact,
    binding.evidenceArtifact,
  ]) {
    Object.assign(participant, attempt);
  }
}

function replaceBindingRequest(
  binding: CandidateBindingFixture,
  overrides: Record<string, unknown>,
) {
  const request = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput(overrides));
  binding.request = request;
  binding.requestSha256 = canonicalTestSha256(request);
  binding.evidenceArtifact.name = `full-release-candidate-v2-${binding.requestSha256}`;
}

function retainedBinding<Request extends Record<string, unknown>>(request: Request) {
  const currentManifest = fullReleaseCandidateManifestFixture();
  const requestSha256 = canonicalTestSha256(request);
  const current = fullReleaseCandidateBindingFixture();
  return {
    ...current,
    request,
    requestSha256,
    evidenceArtifact: {
      ...current.evidenceArtifact,
      name: `full-release-candidate-v2-${requestSha256}`,
    },
    manifestSha256: canonicalTestSha256({ ...currentManifest, request, requestSha256 }),
  };
}

function bindingArgs(
  manifestPath: string,
  artifact: ReturnType<typeof fullReleaseCandidateArtifact>,
) {
  return [
    "binding",
    "--manifest",
    manifestPath,
    ...Object.entries({
      name: artifact.name,
      id: artifact.id,
      digest: artifact.digest,
      "expires-at": artifact.expiresAt,
      "run-id": artifact.runId,
      "run-attempt": artifact.runAttempt,
    }).flatMap(([key, value]) => [`--artifact-${key}`, value]),
  ];
}

describe("full release candidate contract", () => {
  it("canonicalizes equivalent request inputs and expands effective policy", () => {
    const request = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput());
    const reordered = Object.fromEntries(
      Object.entries(fullReleaseCandidateRequestInput()).toReversed(),
    );
    const reorderedRequest = buildFullReleaseCandidateRequest(reordered);

    expect(request).toEqual(reorderedRequest);
    expect(canonicalTestJson(request)).toBe(CANONICAL_REQUEST_JSON);
    expect(canonicalTestSha256(request)).toBe(CANONICAL_REQUEST_SHA256);
  });

  it("canonicalizes historical baseline receipts and equivalent scenario set ordering", () => {
    const request = buildFullReleaseCandidateRequest(
      fullReleaseCandidateRequestInput({
        upgradeSurvivorBaselines: "beta latest 2026.4.23",
        upgradeSurvivorScenarios: "base feishu-channel",
      }),
    );
    const reordered = buildFullReleaseCandidateRequest(
      fullReleaseCandidateRequestInput({
        upgradeSurvivorBaselines: "2026.4.23,latest,beta",
        upgradeSurvivorScenarios: "feishu-channel,base",
      }),
    );

    expect(request).toEqual(reordered);
    expect(request.upgradeBaseline).toBe("openclaw@latest");
    expect(request.upgradeSurvivorBaselines).toEqual([
      "openclaw@2026.4.23",
      "openclaw@beta",
      "openclaw@latest",
    ]);
    expect(canonicalTestSha256(request)).toBe(canonicalTestSha256(reordered));
  });

  it("preserves retired scenario evidence while rejecting new preparation", () => {
    const retainedManifest = fullReleaseCandidateManifestFixture();
    const request = retainedManifest.request;
    request.upgradeSurvivorScenarios = ["base", "msteams-polls"];
    retainedManifest.requestSha256 = canonicalTestSha256(request);
    expect(candidateRequestSha256(request)).toBe(
      "3eb7c6d0842ca3cdc217b4db7a32664b282743ad20c610b58b527f9ff67715fc",
    );
    expect(canonicalFullReleaseCandidateRequestJson(request)).toBe(canonicalTestJson(request));
    const binding = fullReleaseCandidateBindingFixture();
    binding.request = request;
    binding.requestSha256 = retainedManifest.requestSha256;
    binding.manifestSha256 = canonicalTestSha256(retainedManifest);
    binding.evidenceArtifact.name = `full-release-candidate-v2-${binding.requestSha256}`;
    expect(validateFullReleaseCandidateBinding(binding)).toEqual(binding);
    expect(() => validateFullReleaseCandidateRequest(request)).toThrow(
      "invalid published upgrade survivor scenario",
    );
    expect(() =>
      buildFullReleaseCandidateRequest(
        fullReleaseCandidateRequestInput({ upgradeSurvivorScenarios: "msteams-polls" }),
      ),
    ).toThrow("invalid published upgrade survivor scenario");
    expect(runManifestContract(retainedManifest).stderr).toContain(
      "invalid published upgrade survivor scenario",
    );
    for (const source of ["freshBinding", "reusedBinding"]) {
      expect(() => resolveCandidateBinding({ [source]: binding, request, required: true })).toThrow(
        "invalid published upgrade survivor scenario",
      );
    }
  });

  it.each([1, 2])("validates retained v%s digests without rewriting them", (version) => {
    const request = {
      ...Object.fromEntries(
        Object.entries(fullReleaseCandidateManifestFixture().request).filter(
          ([key]) => key !== "upgradeBaseline" && (version !== 1 || key !== "packagePublished"),
        ),
      ),
      schema: `openclaw.full-release-candidate-request/v${version}`,
    };
    const binding = retainedBinding(request);

    expect(validateFullReleaseCandidateBinding(binding)).toEqual(binding);
    expect(candidateRequestSha256(request)).toBe(binding.requestSha256);
    expect(() => validateFullReleaseCandidateRequest(request)).toThrow("schema is invalid");
    if (version === 1) {
      expect(() => candidateArtifactJsonFromBinding(binding)).toThrow(
        "retained v1 candidate evidence cannot supply package provenance",
      );
    }
  });

  it("rejects malformed or noncanonical request policy", () => {
    const request = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput());
    const rejects = (fields: Record<string, unknown>, error: string) =>
      expect(() => validateFullReleaseCandidateRequest({ ...request, ...fields })).toThrow(error);
    rejects({ ignored: true }, "keys must be exactly");
    rejects({ packagePublished: "true" }, "packagePublished must be boolean");
    rejects({ upgradeSurvivorBaselines: ["latest"] }, "not normalized");
    rejects(
      { upgradeSurvivorBaselines: ["openclaw@latest", "openclaw@beta"] },
      "ascending ASCII order",
    );
    rejects({ upgradeSurvivorScenarios: ["feishu-channel", "base"] }, "not normalized");
    rejects(
      { contractVersions: { ...request.contractVersions, sharedImage: 2 } },
      "contract versions are invalid",
    );
  });

  it("runs request, manifest, and binding commands through their subprocess boundary", () => {
    const { result: requestResult, output: requestOutputPath } = runJsonContract(
      "request",
      fullReleaseCandidateRequestInput(),
    );
    expect(requestResult.status, requestResult.stderr).toBe(0);
    expect(readFileSync(requestOutputPath, "utf8")).toBe(CANONICAL_REQUEST_JSON);
    expect(JSON.parse(requestResult.stdout)).toEqual({
      requestJson: CANONICAL_REQUEST_JSON.trimEnd(),
      requestSha256: CANONICAL_REQUEST_SHA256,
    });

    const { result: manifestResult, output: manifestOutputPath } = runJsonContract(
      "manifest",
      manifest(),
    );
    expect(manifestResult.status, manifestResult.stderr).toBe(0);
    const manifestValue = JSON.parse(readFileSync(manifestOutputPath, "utf8"));
    expect(JSON.parse(manifestResult.stdout)).toEqual({
      manifestSha256: canonicalTestSha256(manifestValue),
      requestSha256: manifestValue.requestSha256,
    });

    const evidenceArtifact = fullReleaseCandidateArtifact(
      `full-release-candidate-v2-${manifestValue.requestSha256 as string}`,
      {
        id: "104",
        digest: "4".repeat(64),
      },
    );
    const bindingResult = runContract(bindingArgs(manifestOutputPath, evidenceArtifact));
    expect(bindingResult.status, bindingResult.stderr).toBe(0);
    const binding = JSON.parse(bindingResult.stdout);
    expect(validateFullReleaseCandidateBinding(binding)).toEqual(binding);
    expect(binding).toEqual(fullReleaseCandidateBindingFixture());
  });

  it("returns nonzero for invalid request, manifest, and binding CLI inputs", () => {
    const root = tempDirs.make("full-release-candidate-cli-failure-");
    const requestInputPath = join(root, "request-input.json");
    const invalidManifestPath = join(root, "invalid-manifest.json");
    const manifestOutputPath = join(root, "manifest.json");
    writeFileSync(requestInputPath, JSON.stringify(fullReleaseCandidateRequestInput()));
    writeFileSync(invalidManifestPath, "{");
    writeFileSync(manifestOutputPath, canonicalTestJson(manifest()));

    const missingRequestOutput = runContract(["request", "--input", requestInputPath]);
    expect(missingRequestOutput.status).toBe(1);
    expect(missingRequestOutput.stderr).toContain("missing --output");

    const invalidManifest = runContract([
      "manifest",
      "--input",
      invalidManifestPath,
      "--output",
      join(root, "unused.json"),
    ]);
    expect(invalidManifest.status).toBe(1);
    expect(invalidManifest.stderr).toContain("manifest input is invalid JSON");

    const mismatchedBinding = runContract(
      bindingArgs(
        manifestOutputPath,
        fullReleaseCandidateArtifact("full-release-candidate-v2-deadbeef", {
          id: "104",
          digest: "4".repeat(64),
        }),
      ),
    );
    expect(mismatchedBinding.status).toBe(1);
    expect(mismatchedBinding.stderr).toContain("does not match its manifest");
  });

  it("fails closed on cross-request, cross-package, and cross-attempt evidence", () => {
    const value = manifest();
    const rejects = (fields: Record<string, unknown>, error: string) =>
      expect(runManifestContract({ ...value, ...fields }).stderr).toContain(error);
    rejects({ schema: "openclaw.full-release-candidate/v1" }, "manifest schema is invalid");
    rejects({ requestSha256: "9".repeat(64) }, "does not match the request");
    rejects(
      { sharedImage: { ...value.sharedImage, packageSha256: "8".repeat(64) } },
      "does not match the package",
    );
    rejects(
      { package: { ...value.package, artifact: { ...value.package.artifact, runAttempt: "2" } } },
      "was not produced by the declared attempt",
    );
    rejects(
      { publisher: { ...value.publisher, runAttempt: "2" } },
      "publisher was not bound to the declared producer attempt",
    );
    rejects(
      { producer: { ...value.producer, jobId: "prepare_docker_e2e_image" } },
      "positive decimal string",
    );
  });

  it.each(
    Object.entries({
      "producer job id": (binding) => void (binding.producer.jobId = "202"),
      "producer job name": (binding) => void (binding.producer.jobName = "different producer job"),
      "publisher job id": (binding) => void (binding.publisher.jobId = "203"),
      "publisher job name": (binding) =>
        void (binding.publisher.jobName = "different publisher job"),
      "publisher workflow path": (binding) =>
        void (binding.publisher.workflowPath = COUNTERFEIT_WORKFLOW),
      "producer workflow path": (binding) =>
        void (binding.producer.workflowPath = COUNTERFEIT_WORKFLOW),
      "producer run id tuple": (binding) => setBindingAttempt(binding, { runId: "78" }),
      "producer run attempt tuple": (binding) => setBindingAttempt(binding, { runAttempt: "2" }),
      "repository identity tuple": (binding) => {
        replaceBindingRequest(binding, { repository: "openclaw/other" });
        binding.producer.repository = binding.request.repository;
        binding.publisher.repository = binding.request.repository;
      },
      "tooling identity tuple": (binding) => {
        replaceBindingRequest(binding, { toolingSha: "8".repeat(40) });
        binding.producer.workflowSha = binding.request.toolingSha;
        binding.publisher.workflowSha = binding.request.toolingSha;
      },
      "target source identity tuple": (binding) => {
        replaceBindingRequest(binding, { targetSha: "9".repeat(40) });
        binding.package.sourceSha = binding.request.targetSha;
        binding.prepublishPluginRegistry.sourceSha = binding.request.targetSha;
      },
      "request policy tuple": (binding) => {
        replaceBindingRequest(binding, { releaseSoak: false });
      },
      "preparation plan": (binding) => void (binding.preparation.planSha256 = "5".repeat(64)),
      "required prerelease packages": (binding) =>
        void (binding.preparation.requiredPrepublishPluginPackages = [
          "@openclaw/codex",
          "@openclaw/discord",
        ]),
      "package artifact id": (binding) => void (binding.package.artifact.id = "105"),
      "package artifact digest": (binding) =>
        void (binding.package.artifact.digest = "5".repeat(64)),
      "package artifact expiry": (binding) =>
        void (binding.package.artifact.expiresAt = LATER_EXPIRY),
      "package artifact name": (binding) => void (binding.package.artifact.name = "other-package"),
      "package file name": (binding) => void (binding.package.fileName = "other.tgz"),
      "package and shared image digest tuple": (binding) => {
        binding.package.packageSha256 = "8".repeat(64);
        binding.sharedImage.packageSha256 = "8".repeat(64);
      },
      "package version": (binding) => void (binding.package.version = "2026.8.28-beta.2"),
      "registry artifact id": (binding) =>
        void (binding.prepublishPluginRegistry.artifact.id = "106"),
      "registry artifact digest": (binding) =>
        void (binding.prepublishPluginRegistry.artifact.digest = "6".repeat(64)),
      "registry artifact expiry": (binding) =>
        void (binding.prepublishPluginRegistry.artifact.expiresAt = LATER_EXPIRY),
      "registry artifact name": (binding) =>
        void (binding.prepublishPluginRegistry.artifact.name = "other-registry"),
      "registry manifest": (binding) =>
        void (binding.prepublishPluginRegistry.manifestSha256 = "6".repeat(64)),
      "shared image artifact id": (binding) => void (binding.sharedImage.artifact.id = "107"),
      "shared image artifact digest": (binding) =>
        void (binding.sharedImage.artifact.digest = "7".repeat(64)),
      "shared image artifact expiry": (binding) =>
        void (binding.sharedImage.artifact.expiresAt = LATER_EXPIRY),
      "shared image artifact name": (binding) =>
        void (binding.sharedImage.artifact.name = "other-shared-image"),
      "shared image archive": (binding) =>
        void (binding.sharedImage.archiveSha256 = "7".repeat(64)),
    } satisfies Record<string, (binding: CandidateBindingFixture) => void>),
  )("binds the %s to the manifest digest", (_label, mutate) => {
    const binding = structuredClone(fullReleaseCandidateBindingFixture());
    mutate(binding);
    expect(() => validateFullReleaseCandidateBinding(binding)).toThrow(
      "manifestSha256 does not match its manifest fields",
    );
  });

  it("caps binding size independently of manifest digest coverage", () => {
    const binding = fullReleaseCandidateBindingFixture();
    expect(() =>
      validateFullReleaseCandidateBinding({
        ...binding,
        evidenceArtifact: { ...binding.evidenceArtifact, id: "1".repeat(50_000) },
      }),
    ).toThrow("binding exceeds");
  });

  it("rejects a canonical manifest larger than 32 KiB", () => {
    const requiredPrepublishPluginPackages = Array.from(
      { length: 1_000 },
      (_, index) => `@openclaw/candidate-${String(index).padStart(4, "0")}-${"x".repeat(16)}`,
    );
    const value = manifest({
      preparation: {
        planSha256: "d".repeat(64),
        requiredPrepublishPluginPackages,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(32 * 1024);
    expect(runManifestContract(value).stderr).toContain(
      "full release candidate manifest exceeds 32768 bytes",
    );
  });

  it("rejects unsorted or empty producer package evidence", () => {
    const value = manifest();
    const rejects = (requiredPrepublishPluginPackages: string[], error: string) =>
      expect(
        runManifestContract({
          ...value,
          preparation: { ...value.preparation, requiredPrepublishPluginPackages },
        }).stderr,
      ).toContain(error);
    rejects(["openclaw", "@openclaw/codex"], "ascending ASCII order");
    rejects([], "does not match the request");
  });
});
