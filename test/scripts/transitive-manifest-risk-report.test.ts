import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createTransitiveManifestRiskReport,
  fetchNpmManifest,
  readBoundedNpmRegistryText,
  renderTransitiveManifestRiskMarkdownReport,
} from "../../scripts/transitive-manifest-risk-report.mts";

const now = new Date("2026-05-12T00:00:00Z");
const publishedAt = "2026-05-11T23:00:00Z";
const releaseAge = { now, minimumReleaseAgeMinutes: 2_880 };
function recentFinding(packageName: string, workspaceExclusion?: string) {
  return {
    packageName,
    type: "recently-published-version",
    ...(workspaceExclusion ? { workspaceExcluded: true, workspaceExclusion } : {}),
  };
}

describe("transitive-manifest-risk-report", () => {
  it("reports CLI argument errors without a Node stack trace", () => {
    const unknownArg = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/transitive-manifest-risk-report.mts", "--wat"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(unknownArg).toMatchObject({ status: 1, stdout: "" });
    expect(unknownArg.stderr.trim()).toBe("Unsupported argument: --wat");
    expect(unknownArg.stderr).not.toContain("Node.js");
    expect(unknownArg.stderr).not.toContain("\n    at ");
  });

  it("reports floating transitive specs, lifecycle scripts, exotic sources, and recently published versions", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "parent", version: "1.0.0" },
        { packageName: "tarball-package", version: "https://example.test/pkg.tgz" },
      ],
      ...releaseAge,
      manifestLoader: async ({ packageName, version }) => {
        if (packageName !== "parent" || version !== "1.0.0") {
          throw new Error("unexpected manifest request");
        }
        return {
          publishedAt,
          manifest: {
            dependencies: {
              floating: "^1.2.3",
              exact: "2.0.0",
              gitdep: "github:owner/repo#main",
              malformedSemver: "01.2.3",
              fragmentlessGitPath:
                "git+https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
              pinnedGit: "github:owner/repo#0123456789abcdef0123456789abcdef01234567",
            },
            optionalDependencies: { optionalFloating: "~3.0.0" },
            scripts: { install: "node install.js" },
          },
        };
      },
    });

    expect(report.byType).toEqual({
      "exotic-source": 4,
      "floating-transitive-spec": 5,
      "lifecycle-script": 1,
      "recently-published-version": 1,
    });
    expect(report.workspaceExcludedFindings).toEqual([]);
    expect(report.metadataFailures).toEqual([]);
  });

  it("uses pnpm minimum release age exclusions for recently published versions", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "regular", version: "1.0.0" },
        { packageName: "exact-package", version: "2.0.0" },
        { packageName: "either-version", version: "5.102.1" },
        { packageName: "@scope/native-linux-x64", version: "3.0.0" },
      ],
      ...releaseAge,
      minimumReleaseAgeExclude: [
        "exact-package@2.0.0",
        "either-version@4.47.0 || 5.102.1",
        "@scope/native-*",
      ],
      manifestLoader: async () => ({ publishedAt, manifest: {} }),
    });

    expect(report.byType).toEqual({ "recently-published-version": 1 });
    expect(report.workspaceExcludedByType).toEqual({ "recently-published-version": 3 });
    expect(report.findings).toMatchObject([recentFinding("regular")]);
    expect(report.workspaceExcludedFindings).toMatchObject([
      recentFinding("@scope/native-linux-x64", "@scope/native-*"),
      recentFinding("either-version", "either-version@4.47.0 || 5.102.1"),
      recentFinding("exact-package", "exact-package@2.0.0"),
    ]);

    const markdown = renderTransitiveManifestRiskMarkdownReport(report);
    expect(markdown).toContain(
      "## Recently Published Versions Not Covered By Workspace Exclusions",
    );
    expect(markdown).toContain("## Recently Published Versions Covered By Workspace Exclusions");
    expect(markdown).toContain("Workspace minimum release age: 2880 minutes.");
    expect(markdown).toContain("`regular@1.0.0`: published 2026-05-11T23:00:00Z");
    expect(markdown).toContain(
      "`exact-package@2.0.0`: published 2026-05-11T23:00:00Z; workspace exclusion `exact-package@2.0.0`",
    );
    expect(markdown).not.toContain(
      "`regular@1.0.0`: published 2026-05-11T23:00:00Z; minimum release age 2880 minutes",
    );
  });

  it("documents JSON completeness and renders grouped Markdown summaries", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "openclaw/plugin-sdk/llm", version: "0.74.0" },
        { packageName: "aaa-package", version: "1.0.0" },
        { packageName: "recent-package", version: "1.0.0" },
      ],
      ...releaseAge,
      minimumReleaseAgeExclude: ["recent-package@1.0.0"],
      manifestLoader: async ({ packageName }) => ({
        publishedAt: packageName === "recent-package" ? publishedAt : "2026-04-01T00:00:00Z",
        manifest: {
          dependencies:
            packageName === "openclaw/plugin-sdk/llm"
              ? { "@mistralai/mistralai": "^2.2.0" }
              : {
                  [packageName === "recent-package" ? "recent-dependency" : "aaa-dependency"]:
                    "^1.0.0",
                },
        },
      }),
    });

    const markdown = renderTransitiveManifestRiskMarkdownReport(report);

    expect(markdown).toContain("# Transitive Manifest Risk Report");
    expect(markdown).toContain("## Scope");
    expect(markdown).toContain("published package manifests for resolved packages");
    expect(markdown).toContain("It is report-only.");
    expect(markdown).toContain("Resolved package versions inspected");
    expect(markdown).toContain("Reported risk signals");
    expect(markdown).toContain("Signals covered by workspace policy exclusions");
    expect(markdown).toContain("## Reported Risk Signals By Type");
    expect(markdown).toContain("## Signals Covered By Workspace Policy Exclusions");
    expect(markdown).toContain("not included in the reported risk signal totals");
    expect(markdown).toContain("## Complete Evidence");
    expect(markdown).toContain("The complete reported signal list is available in the JSON report");
    expect(markdown).toContain("## Published Package Manifests With Risk Findings");
    expect(markdown).toContain("`openclaw/plugin-sdk/llm@0.74.0`: 1 manifest finding");
    expect(markdown).toContain("`aaa-package@1.0.0`: 1 manifest finding");
    expect(markdown).toContain("## Floating Dependency Targets");
    expect(markdown).toContain("`@mistralai/mistralai`: 1 declarations");
    expect(markdown).toContain("`aaa-dependency`: 1 declarations");
    expect(markdown).not.toContain("## Packages With Findings");
    expect(markdown).not.toContain("## Finding Details");
    expect(markdown).not.toContain("## Notable Findings");
    expect(markdown).not.toContain("## Additional Sample Findings");
  });

  it("fetches full npm packuments for the requested manifest version", async () => {
    const versionManifest = {
      dependencies: { exact: "1.2.3" },
      scripts: { install: "node install.js" },
    };
    const versionPublishedAt = "2026-05-12T00:00:00.000Z";
    const fetchCalls: [string, string | null, AbortSignal | null][] = [];
    const manifest = await fetchNpmManifest({
      packageName: "@scope/package",
      version: "1.0.0",
      registryBaseUrl: "https://registry.example.test",
      fetchImpl: async (url, init) => {
        const requestUrl = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        fetchCalls.push([
          requestUrl,
          new Headers(init?.headers).get("accept"),
          init?.signal instanceof AbortSignal ? init.signal : null,
        ]);
        return new Response(
          JSON.stringify({
            time: { "1.0.0": versionPublishedAt },
            versions: { "1.0.0": versionManifest },
          }),
          { status: 200 },
        );
      },
    });

    expect(fetchCalls).toEqual([
      [
        "https://registry.example.test/@scope%2Fpackage",
        "application/json",
        expect.any(AbortSignal),
      ],
    ]);
    expect(manifest).toEqual({ publishedAt: versionPublishedAt, manifest: versionManifest });
  });

  it("cancels stalled npm registry body reads when the request aborts", async () => {
    const controller = new AbortController();
    let canceled = false;
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read() {
              return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {
              throw new Error("releaseLock should not run while a read is pending");
            },
          };
        },
      },
    } as unknown as Response;

    const readPromise = readBoundedNpmRegistryText(response, 8, {
      signal: controller.signal,
    });
    controller.abort(new Error("npm registry request timed out"));

    await expect(readPromise).rejects.toThrow("npm registry request timed out");
    expect(canceled).toBe(true);
  });

  it.each(["12", "1e3"])("caps npm registry bodies with content-length %s", async (length) => {
    const encoder = new TextEncoder();
    let readStarted = false;
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          readStarted = true;
          controller.enqueue(encoder.encode("123456789"));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-length": length } },
    );

    await expect(readBoundedNpmRegistryText(response, 8)).rejects.toThrow(
      "npm registry response exceeded 8 bytes",
    );
    if (length === "1e3") {
      expect(readStarted).toBe(true);
    }
    expect(canceled).toBe(true);
  });
});
