import { createHash } from "node:crypto";
import { constants, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import corePackagePolicy from "../../scripts/lib/npm-core-release-packages.json" with { type: "json" };
import {
  createPublishPreflightEvidenceClient,
  ensureReleasePublishToolingTag,
  inspectPublishPreflightTelegramEvidence,
  readPublishPreflightRelease,
  validatePublishPreflightNpm,
  verifyPublishedPreflightTarball,
  type PublishPreflightGh,
} from "../../scripts/lib/release-publish-preflight-evidence.mts";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { fixtureGit } from "./release-publish.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceTemplates = useAutoCleanupTempDirTracker(afterAll);
let sourceTemplate: { source: string; targetSha: string } | undefined;
const version = "2026.9.5";
const repo = "openclaw/openclaw";
const api = (endpoint: string) => ["api", `repos/${repo}/${endpoint}`, "--method", "GET"];
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("protected tooling tag resolution", () => {
  const toolingSha = "a".repeat(40);
  const prefix = "release-publish/aaaaaaaaaaaa-";
  const compare = [...api(`compare/${toolingSha}...main`), "--jq", ".status"];
  const inventory = api(`git/matching-refs/tags/${prefix}`);
  const ref = (suffix: string, type = "commit", sha = toolingSha) => ({
    ref: `refs/tags/${prefix}${suffix}`,
    object: { type, sha },
  });
  const scriptedGh = (...responses: string[]) => {
    const runGh = vi.fn<PublishPreflightGh>(() => {
      throw new Error("Unexpected GitHub request");
    });
    for (const response of responses) {
      runGh.mockReturnValueOnce(response);
    }
    return runGh;
  };

  it.each(["ahead", "identical", "behind", "diverged"])(
    "qualifies %s main ancestry before selecting the newest lightweight tag",
    (ancestry) => {
      const runGh = scriptedGh(
        `${ancestry}\n`,
        JSON.stringify([
          ref("10"),
          ref("9"),
          ref("11", "tag"),
          ref("12", "commit", "b".repeat(40)),
          ref("0"),
          ref("01"),
          ref("13-extra"),
          null,
        ]),
      );
      const ensure = () => ensureReleasePublishToolingTag({ runGh, repo, toolingSha });
      if (["behind", "diverged"].includes(ancestry)) {
        expect(ensure).toThrow(`Tooling SHA ${toolingSha} is not reachable from trusted main.`);
        expect(runGh.mock.calls.map(([args]) => args)).toEqual([compare]);
      } else {
        expect(ensure()).toEqual({ tag: `${prefix}10`, created: false });
        expect(runGh.mock.calls.map(([args]) => args)).toEqual([compare, inventory]);
      }
    },
  );

  it.each([true, false])(
    "mints through git refs and verifies the created target (matches: %s)",
    (matches) => {
      const tag = `${prefix}1750000000`;
      const runGh = scriptedGh(
        "ahead",
        JSON.stringify([ref("1750000001", "tag"), ref("1750000002", "commit", "b".repeat(40))]),
        "ignored POST output",
        JSON.stringify({ object: { type: "commit", sha: matches ? toolingSha : "b".repeat(40) } }),
      );
      const ensure = () =>
        ensureReleasePublishToolingTag({ runGh, repo, toolingSha, now: () => 1750000000999 });
      if (matches) {
        expect(ensure()).toEqual({ tag, created: true });
      } else {
        expect(ensure).toThrow(`Protected tooling tag ${tag} does not resolve to ${toolingSha}.`);
      }
      expect(runGh.mock.calls.map(([args]) => args)).toEqual([
        compare,
        inventory,
        [
          "api",
          `repos/${repo}/git/refs`,
          "--method",
          "POST",
          "-f",
          `ref=refs/tags/${tag}`,
          "-f",
          `sha=${toolingSha}`,
        ],
        api(`git/ref/tags/${tag}`),
      ]);
    },
  );

  it("rejects malformed SHAs before API access and malformed inventory before mutation", () => {
    const runGh = scriptedGh("ahead", "{}");
    expect(() => ensureReleasePublishToolingTag({ runGh, repo, toolingSha: "ABC123" })).toThrow(
      "Tooling SHA must be a lowercase 40-character commit SHA.",
    );
    expect(runGh).not.toHaveBeenCalled();
    expect(() => ensureReleasePublishToolingTag({ runGh, repo, toolingSha })).toThrow(
      "Invalid protected tooling tag inventory.",
    );
    expect(runGh.mock.calls.map(([args]) => args)).toEqual([compare, inventory]);
  });
});

describe("publish preflight release inventory", () => {
  it.each(["malformed", "interrupted", "unbounded"])(
    "refuses absence from an %s inventory",
    (state) => {
      let reads = 0;
      const runGh = (args: string[]) => {
        if (args[1]?.includes("/releases/tags/")) {
          throw new Error("HTTP 404: Not Found");
        }
        reads++;
        if (state === "malformed") {
          return JSON.stringify([{ draft: true }]);
        }
        if (state === "interrupted" && reads === 2) {
          throw new Error("HTTP 403: Forbidden");
        }
        if (reads > 20) {
          throw new Error("Lookup exceeded its page limit.");
        }
        return JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({ tag_name: `other-${reads}-${index}` })),
        );
      };
      expect(() => readPublishPreflightRelease(runGh, repo, `v${version}`)).toThrow(
        state === "malformed"
          ? "Invalid GitHub release inventory."
          : state === "interrupted"
            ? "HTTP 403: Forbidden"
            : "GitHub release inventory exceeds the bounded lookup",
      );
    },
  );

  it("does not mask a failed exact-tag read as absence", () => {
    const runGh = vi.fn(() => {
      throw new Error("HTTP 502: Bad Gateway");
    });
    expect(() => readPublishPreflightRelease(runGh, repo, `v${version}`)).toThrow("HTTP 502");
    expect(runGh).toHaveBeenCalledTimes(1);
  });
});

describe("publish preflight optional Telegram evidence", () => {
  const workflowRef = `release-publish/${"a".repeat(12)}-123`;
  const completedRun = {
    name: "NPM Telegram Beta E2E",
    event: "workflow_dispatch",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const inspect = (runGh: PublishPreflightGh, runId = "123") =>
    inspectPublishPreflightTelegramEvidence({ repo, runId, workflowRef, runGh });

  it.each<
    [Partial<Omit<typeof completedRun, "conclusion">> & { conclusion?: string | null }, string]
  >([
    [{ head_branch: "main", conclusion: "success" }, "PASS"],
    [{ head_branch: workflowRef, conclusion: "success" }, "PASS"],
    [{ head_branch: "main", conclusion: "failure" }, "WARN"],
    [{ head_branch: workflowRef, conclusion: "cancelled" }, "WARN"],
    [{ name: "CI" }, "FAIL"],
    [{ event: "push" }, "FAIL"],
    [{ head_branch: "release-publish/bbbbbbbbbbbb-123" }, "FAIL"],
    [{ status: "in_progress", conclusion: null }, "FAIL"],
  ])("qualifies optional Telegram evidence: %j", (overrides, expected) => {
    const runGh = vi.fn(() => JSON.stringify({ ...completedRun, ...overrides }));
    expect(inspect(runGh)).toMatchObject({
      status: expected,
      ...(expected === "FAIL"
        ? { remediation: expect.stringContaining("omit the optional npm_telegram_run_id") }
        : {}),
    });
    expect(runGh.mock.calls).toEqual([[api("actions/runs/123")]]);
  });

  it("does not query an invalid run id and reports an unavailable valid run", () => {
    const runGh = vi.fn(() => {
      throw new Error("HTTP 404: Not Found");
    });
    expect(inspect(runGh, "../jobs/123").status).toBe("FAIL");
    expect(runGh).not.toHaveBeenCalled();
    expect(inspect(runGh)).toMatchObject({ status: "FAIL", message: "HTTP 404: Not Found" });
  });
});

function buildCoreEvidenceSource() {
  const source = sourceTemplates.make("publish-preflight-source-");
  writeJsonFile(join(source, "package.json"), {
    name: "openclaw",
    version,
    dependencies: { "@openclaw/ai": "workspace:*" },
  });
  for (const policy of corePackagePolicy) {
    writeJsonFile(join(source, policy.path, "package.json"), {
      name: policy.name,
      version,
      openclaw: { release: { publishToNpm: true } },
    });
  }
  const git = fixtureGit(source, "Release fixture", "release-fixture@example.invalid");
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "commit",
    "--quiet",
    "-m",
    "release source fixture",
  );
  const targetSha = git("rev-parse", "HEAD");
  return { source, targetSha };
}

function coreEvidenceFixture() {
  sourceTemplate ??= buildCoreEvidenceSource();
  const source = tempDirs.make("publish-preflight-source-");
  // Mutable Git state belongs to each case; only the pristine source seed is reused.
  cpSync(sourceTemplate.source, source, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const { targetSha } = sourceTemplate;
  const artifacts = tempDirs.make("publish-preflight-artifacts-");
  const writeArtifact = (name: string, bytes: string | Uint8Array) =>
    writeFileSync(join(artifacts, name), bytes);
  vi.stubEnv("GIT_DIR", join(source, ".git"));
  vi.stubEnv("GIT_WORK_TREE", source);
  const corePackages = corePackagePolicy.map((policy) => {
    const tarballName = `${policy.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
    const bytes = Buffer.from(`synthetic immutable ${policy.name}`);
    writeArtifact(tarballName, bytes);
    return {
      packageName: policy.name,
      packageVersion: version,
      tarballName,
      tarballSha256: sha256(bytes),
    };
  });
  const rootBytes = Buffer.from("synthetic immutable openclaw");
  writeArtifact("openclaw.tgz", rootBytes);
  writeArtifact(
    "core-packages-SHA256SUMS",
    corePackages.map((entry) => `${entry.tarballSha256}  ${entry.tarballName}\n`).join(""),
  );
  const payload = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const manifest = {
    version: 1,
    releaseTag: `v${version}`,
    releaseSha: targetSha,
    packageVersion: version,
    npmDistTag: "latest",
    tarballName: "openclaw.tgz",
    tarballSha256: sha256(rootBytes),
    corePackageTarballs: corePackages,
    dependencyTarballs: [corePackages[0]],
    pluginSdkApi: createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.8.1",
      baseSha: "b".repeat(40),
      headSha: targetSha,
      workflowSha: targetSha,
      diff: { ...payload, digest: sha256(JSON.stringify(payload)) },
    }),
  };
  const manifestPath = join(artifacts, "preflight-manifest.json");
  const writeManifest = () => writeJsonFile(manifestPath, manifest);
  writeManifest();
  const runGh = (args: string[]) => {
    if (args[1]?.includes("/compare/")) {
      return JSON.stringify({ status: "identical" });
    }
    if (args[1] === "repos/openclaw/openclaw/actions/runs/2") {
      return JSON.stringify({
        id: 2,
        path: ".github/workflows/openclaw-npm-release.yml",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: targetSha,
        run_attempt: 1,
      });
    }
    throw new Error(`Unexpected GitHub request: ${args.join(" ")}`);
  };
  return {
    writeArtifact,
    corePackages,
    manifest,
    writeManifest,
    verify: () =>
      validatePublishPreflightNpm(
        {
          repo: "openclaw/openclaw",
          tag: `v${version}`,
          targetSha,
          toolingSha: targetSha,
          workflowRef: `release-publish/${targetSha.slice(0, 12)}-123`,
          npmDistTag: "latest",
          preflightRunId: "2",
          fullReleaseValidationRunId: "1",
          fullReleaseValidationRunAttempt: "1",
          pluginSdkApiAcknowledgement: "",
          currentSelectorRef: `v${version}`,
          currentSelectorSha: targetSha,
          runGh,
        },
        { npmManifest: manifest, npmManifestPath: manifestPath },
      ),
  };
}

describe("publish preflight immutable npm evidence", () => {
  it("qualifies the complete prepared core package set against exact source metadata", async () => {
    const fixture = coreEvidenceFixture();
    expect((await fixture.verify()).corePackages).toEqual(fixture.corePackages);
  });

  it.each([
    ["missing required package", "missing from the manifest"],
    ["corrupt core bytes", "digest mismatch"],
    ["duplicate core descriptor", "duplicate prepared core package"],
    ["invalid checksums", "checksum verification failed"],
    ["changed reused manifest", "changed after candidate validation"],
    ["changed reused root bytes", "wrong digest"],
  ])("rejects %s before publication", async (mode, message) => {
    const fixture = coreEvidenceFixture();
    if (mode === "missing required package") {
      fixture.manifest.corePackageTarballs = fixture.corePackages.slice(0, -1);
    }
    if (mode === "duplicate core descriptor") {
      fixture.manifest.corePackageTarballs = [fixture.corePackages[0]!, fixture.corePackages[0]!];
    }
    fixture.writeManifest();
    if (mode === "corrupt core bytes") {
      fixture.writeArtifact(fixture.corePackages[1]!.tarballName, "changed core bytes");
    }
    if (mode === "invalid checksums") {
      fixture.writeArtifact("core-packages-SHA256SUMS", "broken\n");
    }
    if (mode === "changed reused manifest") {
      fixture.manifest.tarballName = "changed.tgz";
    }
    if (mode === "changed reused root bytes") {
      fixture.writeArtifact("openclaw.tgz", "changed root bytes");
    }
    await expect(fixture.verify()).rejects.toThrow(message);
  });

  it.each([
    ["exact bytes", undefined],
    ["byte conflict", "different from this preflight"],
    ["foreign origin", "canonical registry origin"],
    ["wrong version", "identity differs"],
  ])("verifies published core resume using %s", async (mode, message) => {
    const bytes = Buffer.from("synthetic published core tarball");
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith(".tgz")) {
        return new Response(mode === "byte conflict" ? "changed bytes" : bytes);
      }
      return Response.json({
        name: "openclaw",
        versions: {
          [version]: {
            name: "openclaw",
            version: mode === "wrong version" ? "2026.9.4" : version,
            dist: {
              tarball:
                mode === "foreign origin"
                  ? "https://example.invalid/package.tgz"
                  : `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`,
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const result = verifyPublishedPreflightTarball({
      packageName: "openclaw",
      version,
      tarballSha256: sha256(bytes),
    });
    if (message) {
      await expect(result).rejects.toThrow(message);
    } else {
      await expect(result).resolves.toBe(createHash("sha512").update(bytes).digest("hex"));
    }
    if (mode === "foreign origin") {
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.skipIf(process.platform === "win32")(
    "downloads each exact validation attempt once and verifies its artifact digest",
    () => {
      const directory = tempDirs.make("publish-preflight-manifest-");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const downloads = join(directory, "downloads");
      writeFileSync(downloads, "");
      const manifests = [1, 2].map((attempt) => ({
        version: 4,
        workflowName: "Full Release Validation",
        runId: "123",
        runAttempt: String(attempt),
      }));
      const artifacts = manifests.map((manifest, index) => {
        const archive = makeStoredZip({
          "full-release-validation-manifest.json": JSON.stringify(manifest),
        });
        const id = 90 + index;
        writeFileSync(join(directory, `${id}.zip`), archive);
        return {
          id,
          name: `full-release-validation-123-${index + 1}`,
          expired: false,
          digest: `sha256:${sha256(archive)}`,
          size_in_bytes: archive.length,
          workflow_run: { id: 123 },
        };
      });
      writeFileSync(
        join(bin, "gh"),
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const endpoint = args[1];
const artifacts = ${JSON.stringify(artifacts)};
if (args[0] !== "api") throw new Error("Unexpected gh command");
if (endpoint.includes("/actions/runs/123/artifacts?")) process.stdout.write(JSON.stringify({ artifacts }));
else {
  const match = new RegExp("/actions/artifacts/(90|91)(/zip)?$").exec(endpoint);
  if (!match) throw new Error("Unexpected endpoint: " + endpoint);
  if (match[2]) {
    fs.appendFileSync(${JSON.stringify(downloads)}, match[1] + "\\n");
    process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(directory)}, match[1] + ".zip")));
  } else process.stdout.write(JSON.stringify(artifacts.find(entry => String(entry.id) === match[1])));
}
`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("OPENCLAW_GH_BIN", "");
      const client = createPublishPreflightEvidenceClient("openclaw/openclaw");
      expect(client.loadManifest("123", 1)?.manifest).toEqual(manifests[0]);
      writeFileSync(join(directory, "90.zip"), "changed after the authenticated read");
      expect(client.loadManifest("123", 1)?.manifest).toEqual(manifests[0]);
      expect(client.loadManifest("123", 2)?.manifest).toEqual(manifests[1]);
      expect(readFileSync(downloads, "utf8").trim().split("\n")).toEqual(["90", "91"]);
    },
  );
});
