import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createNestedGitEnv, writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.5";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("protected tooling tag resolution", () => {
  const repo = "openclaw/openclaw";
  const toolingSha = "a".repeat(40);
  const prefix = "release-publish/aaaaaaaaaaaa-";
  const compare = [
    "api",
    `repos/${repo}/compare/${toolingSha}...main`,
    "--method",
    "GET",
    "--jq",
    ".status",
  ];
  const inventory = ["api", `repos/${repo}/git/matching-refs/tags/${prefix}`, "--method", "GET"];
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

  it.each([
    ["reuse", "ahead"],
    ["reuse", "identical"],
    ["create", "ahead"],
    ["wrong target", "ahead"],
    ["untrusted", "behind"],
    ["untrusted", "diverged"],
    ["invalid inventory", "ahead"],
  ])("resolves protected tooling tags: %s / %s", (mode, ancestry) => {
    const tag = `${prefix}1750000000`;
    const creates = mode === "create" || mode === "wrong target";
    const responses = [`${ancestry}\n`];
    const calls = [compare];
    if (mode !== "untrusted") {
      responses.push(
        mode === "invalid inventory"
          ? "{}"
          : JSON.stringify(
              creates
                ? [ref("1750000001", "tag"), ref("1750000002", "commit", "b".repeat(40))]
                : [
                    ref("10"),
                    ref("9"),
                    ref("11", "tag"),
                    ref("12", "commit", "b".repeat(40)),
                    ref("0"),
                    ref("01"),
                    ref("13-extra"),
                    null,
                  ],
            ),
      );
      calls.push(inventory);
    }
    if (creates) {
      responses.push(
        "ignored POST output",
        JSON.stringify({
          object: {
            type: "commit",
            sha: mode === "create" ? toolingSha : "b".repeat(40),
          },
        }),
      );
      calls.push(
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
        ["api", `repos/${repo}/git/ref/tags/${tag}`, "--method", "GET"],
      );
    }
    const runGh = scriptedGh(...responses);
    if (mode === "invalid inventory") {
      expect(() => ensureReleasePublishToolingTag({ runGh, repo, toolingSha: "ABC123" })).toThrow(
        "Tooling SHA must be a lowercase 40-character commit SHA.",
      );
      expect(runGh).not.toHaveBeenCalled();
    }
    const ensure = () =>
      ensureReleasePublishToolingTag({
        runGh,
        repo,
        toolingSha,
        now: () => 1750000000999,
      });
    const error =
      mode === "wrong target"
        ? `Protected tooling tag ${tag} does not resolve to ${toolingSha}.`
        : mode === "untrusted"
          ? `Tooling SHA ${toolingSha} is not reachable from trusted main.`
          : mode === "invalid inventory"
            ? "Invalid protected tooling tag inventory."
            : undefined;
    if (error) {
      expect(ensure).toThrow(error);
    } else {
      expect(ensure()).toEqual({ tag: creates ? tag : `${prefix}10`, created: creates });
    }
    expect(runGh.mock.calls.map(([args]) => args)).toEqual(calls);
  });
});

describe("publish preflight release inventory", () => {
  it.each([
    ["published", undefined],
    ["draft", undefined],
    ["malformed", "Invalid GitHub release inventory."],
    ["interrupted", "HTTP 403: Forbidden"],
    ["unbounded", "GitHub release inventory exceeds the bounded lookup"],
    ["failed exact lookup", "HTTP 502"],
  ])("retains release evidence or refuses unresolved %s lookup", (state, error) => {
    const release = {
      id: 8,
      draft: state === "draft",
      prerelease: false,
      tag_name: `v${version}`,
      html_url: `https://github.com/openclaw/openclaw/releases/tag/v${version}`,
      target_commitish: "a".repeat(40),
      body: "Published release notes",
      assets: [{ name: "dependency-evidence.zip" }],
    };
    let reads = 0;
    const runGh = vi.fn((args: string[]) => {
      if (args[1]?.includes("/releases/tags/")) {
        if (state === "published") {
          return JSON.stringify(release);
        }
        throw new Error(
          state === "failed exact lookup" ? "HTTP 502: Bad Gateway" : "HTTP 404: Not Found",
        );
      }
      reads++;
      if (state === "draft") {
        return JSON.stringify([release]);
      }
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
    });
    const read = () => readPublishPreflightRelease(runGh, "openclaw/openclaw", `v${version}`);
    if (error) {
      expect(read).toThrow(error);
    } else {
      expect(read()).toEqual({ state: "found", release });
    }
    if (state === "failed exact lookup") {
      expect(runGh).toHaveBeenCalledTimes(1);
    }
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

  it.each([
    { run: { head_branch: "main", conclusion: "success" }, expected: "PASS" },
    { run: { head_branch: workflowRef, conclusion: "success" }, expected: "PASS" },
    { run: { head_branch: "main", conclusion: "failure" }, expected: "WARN" },
    { run: { head_branch: workflowRef, conclusion: "cancelled" }, expected: "WARN" },
    { run: { name: "CI" }, expected: "FAIL" },
    { run: { event: "push" }, expected: "FAIL" },
    { run: { head_branch: "release-publish/bbbbbbbbbbbb-123" }, expected: "FAIL" },
    { run: { status: "in_progress", conclusion: null }, expected: "FAIL" },
  ])("qualifies optional Telegram evidence: %j", ({ run, expected }) => {
    const runGh = vi.fn(() => JSON.stringify({ ...completedRun, ...run }));
    const gate = inspectPublishPreflightTelegramEvidence({
      repo: "openclaw/openclaw",
      runId: "123",
      workflowRef,
      runGh,
    });
    expect(gate.status).toBe(expected);
    expect(runGh.mock.calls).toEqual([
      [["api", "repos/openclaw/openclaw/actions/runs/123", "--method", "GET"]],
    ]);
    if (expected === "FAIL") {
      expect(gate.remediation).toContain("omit the optional npm_telegram_run_id");
    }
  });

  it("does not query an invalid run id and reports an unavailable valid run", () => {
    const runGh = vi.fn(() => {
      throw new Error("HTTP 404: Not Found");
    });
    const inspect = (runId: string) =>
      inspectPublishPreflightTelegramEvidence({
        repo: "openclaw/openclaw",
        runId,
        workflowRef,
        runGh,
      });
    expect(inspect("../jobs/123").status).toBe("FAIL");
    expect(runGh).not.toHaveBeenCalled();
    expect(inspect("123")).toMatchObject({ status: "FAIL", message: "HTTP 404: Not Found" });
  });
});

function coreEvidenceFixture() {
  const source = tempDirs.make("publish-preflight-source-");
  const artifacts = tempDirs.make("publish-preflight-artifacts-");
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
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        source,
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=release-fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "release source fixture");
  const targetSha = git("rev-parse", "HEAD");
  vi.stubEnv("GIT_DIR", join(source, ".git"));
  vi.stubEnv("GIT_WORK_TREE", source);
  const corePackages = corePackagePolicy.map((policy) => {
    const tarballName = `${policy.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
    const bytes = Buffer.from(`synthetic immutable ${policy.name}`);
    writeFileSync(join(artifacts, tarballName), bytes);
    return {
      packageName: policy.name,
      packageVersion: version,
      tarballName,
      tarballSha256: sha256(bytes),
    };
  });
  const rootBytes = Buffer.from("synthetic immutable openclaw");
  writeFileSync(join(artifacts, "openclaw.tgz"), rootBytes);
  writeFileSync(
    join(artifacts, "core-packages-SHA256SUMS"),
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
    artifacts,
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
  it.each([
    ["complete prepared core package set", undefined],
    ["missing required package", "missing from the manifest"],
    ["corrupt core bytes", "digest mismatch"],
    ["duplicate core descriptor", "duplicate prepared core package"],
    ["invalid checksums", "checksum verification failed"],
    ["changed reused manifest", "changed after candidate validation"],
    ["changed reused root bytes", "wrong digest"],
  ])("qualifies immutable npm evidence: %s", (mode, message) => {
    const fixture = coreEvidenceFixture();
    if (mode === "missing required package") {
      fixture.manifest.corePackageTarballs = fixture.corePackages.slice(0, -1);
    }
    if (mode === "duplicate core descriptor") {
      fixture.manifest.corePackageTarballs = [fixture.corePackages[0]!, fixture.corePackages[0]!];
    }
    fixture.writeManifest();
    if (mode === "corrupt core bytes") {
      writeFileSync(
        join(fixture.artifacts, fixture.corePackages[1]!.tarballName),
        "changed core bytes",
      );
    }
    if (mode === "invalid checksums") {
      writeFileSync(join(fixture.artifacts, "core-packages-SHA256SUMS"), "broken\n");
    }
    if (mode === "changed reused manifest") {
      fixture.manifest.tarballName = "changed.tgz";
    }
    if (mode === "changed reused root bytes") {
      writeFileSync(join(fixture.artifacts, "openclaw.tgz"), "changed root bytes");
    }
    if (message) {
      expect(() => fixture.verify()).toThrow(message);
    } else {
      expect(fixture.verify().corePackages).toEqual(fixture.corePackages);
    }
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
    async () => {
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
      const artifacts = await Promise.all(
        manifests.map(async (manifest, index) => {
          const archive = await new JSZip()
            .file("full-release-validation-manifest.json", JSON.stringify(manifest))
            .generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" });
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
        }),
      );
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
