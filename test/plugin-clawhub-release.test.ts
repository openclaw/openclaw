// Plugin ClawHub release tests validate plugin release metadata and artifacts.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenClawReleaseClawHubPlan,
  buildOpenClawReleaseClawHubRuntimeState,
  parseOpenClawReleaseClawHubPlanArgs,
} from "../scripts/lib/openclaw-release-clawhub-plan.ts";
import {
  collectClawHubPublishablePluginPackages,
  collectClawHubVersionGateErrors,
  collectPluginClawHubReleasePathsFromGitRange,
  collectPluginClawHubReleasePlan,
  resolveChangedClawHubPublishablePluginPackages,
  resolveSelectedClawHubPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-clawhub-release.ts";
import {
  collectPublishablePluginPackages,
  OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
} from "../scripts/lib/plugin-npm-release.ts";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("resolveChangedClawHubPublishablePluginPackages", () => {
  const publishablePlugins: PublishablePluginPackage[] = [
    {
      extensionId: "feishu",
      packageDir: "extensions/feishu",
      packageName: "@openclaw/feishu",
      version: "2026.4.1",
      channel: "stable",
      publishTag: "latest",
    },
    {
      extensionId: "zalo",
      packageDir: "extensions/zalo",
      packageName: "@openclaw/zalo",
      version: "2026.4.1-beta.1",
      channel: "beta",
      publishTag: "beta",
    },
  ];

  it("ignores shared release-tooling changes", () => {
    expect(
      resolveChangedClawHubPublishablePluginPackages({
        plugins: publishablePlugins,
        changedPaths: ["pnpm-lock.yaml"],
      }),
    ).toStrictEqual([]);
  });
});

describe("collectClawHubPublishablePluginPackages", () => {
  it("requires the ClawHub external plugin contract", () => {
    const repoDir = createTempPluginRepo({
      includeClawHubContract: false,
    });

    expect(() => collectClawHubPublishablePluginPackages(repoDir)).toThrow(
      "openclaw.compat.pluginApi is required for external code plugin packages.",
    );
  });

  it("rejects unsafe extension directory names", () => {
    const repoDir = createTempPluginRepo({
      extensionId: "Demo Plugin",
    });

    expect(() => collectClawHubPublishablePluginPackages(repoDir)).toThrow(
      "Demo Plugin: extension directory name must match",
    );
  });

  it("validates only selected package names when filters are provided", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["broken-plugin"],
    });
    writeFileSync(
      join(repoDir, "extensions", "broken-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/broken-plugin",
          version: "2026.4.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );

    expect(
      collectClawHubPublishablePluginPackages(repoDir, {
        packageNames: ["@openclaw/demo-plugin"],
      }).map((plugin) => plugin.packageName),
    ).toEqual(["@openclaw/demo-plugin"]);
  });
});

describe("OpenClaw dual-published plugin metadata", () => {
  const dualPublishedPlugins = [
    {
      extensionId: "cohere",
      packageName: "@openclaw/cohere-provider",
      install: {
        clawhubSpec: "clawhub:@openclaw/cohere-provider",
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.8",
        npmSpec: "@openclaw/cohere-provider",
      },
    },
    {
      extensionId: "diagnostics-otel",
      packageName: "@openclaw/diagnostics-otel",
      install: {
        clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.25",
        npmSpec: "@openclaw/diagnostics-otel",
      },
    },
    {
      extensionId: "diagnostics-prometheus",
      packageName: "@openclaw/diagnostics-prometheus",
      install: {
        clawhubSpec: "clawhub:@openclaw/diagnostics-prometheus",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.25",
        npmSpec: "@openclaw/diagnostics-prometheus",
      },
    },
    {
      extensionId: "gmi",
      packageName: "@openclaw/gmi-provider",
      install: {
        clawhubSpec: "clawhub:@openclaw/gmi-provider",
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.8",
        npmSpec: "@openclaw/gmi-provider",
      },
    },
  ] as const;

  it("keeps dual-published plugins selectable through both ClawHub and npm release paths", () => {
    const packageNames = dualPublishedPlugins.map((plugin) => plugin.packageName);
    const clawHubPublishable = collectClawHubPublishablePluginPackages(undefined, {
      packageNames,
    });
    const npmPublishable = collectPublishablePluginPackages(undefined, {
      packageNames,
    });

    expect(clawHubPublishable.map((plugin) => plugin.packageName)).toEqual(packageNames);
    expect(npmPublishable.map((plugin) => plugin.packageName)).toEqual(packageNames);

    for (const plugin of dualPublishedPlugins) {
      const packageJson = JSON.parse(
        readFileSync(`extensions/${plugin.extensionId}/package.json`, "utf8"),
      ) as {
        openclaw?: {
          install?: {
            clawhubSpec?: string;
            defaultChoice?: string;
            minHostVersion?: string;
            npmSpec?: string;
          };
          release?: {
            publishToClawHub?: boolean;
            publishToNpm?: boolean;
          };
        };
      };

      expect(packageJson.openclaw?.install).toEqual(plugin.install);
      expect(packageJson.openclaw?.release).toEqual({
        publishToClawHub: true,
        publishToNpm: true,
      });
    }
  });
});

describe("collectClawHubVersionGateErrors", () => {
  it("requires a version bump when a publishable plugin changes", () => {
    const repoDir = createTempPluginRepo();
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "index.ts"),
      "export const demo = 2;\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "change plugin",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toEqual([
      "@openclaw/demo-plugin@2026.4.1: changed publishable plugin still has the same version in package.json.",
    ]);
  });

  it("does not require a version bump for the first ClawHub opt-in", () => {
    const repoDir = createTempPluginRepo({
      publishToClawHub: false,
    });
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/demo-plugin",
          version: "2026.4.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            compat: {
              pluginApi: ">=2026.4.1",
            },
            install: {
              npmSpec: "@openclaw/demo-plugin",
            },
            build: {
              openclawVersion: "2026.4.1",
            },
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "opt in",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toStrictEqual([]);
  });

  it("does not require a version bump for shared release-tooling changes", () => {
    const repoDir = createTempPluginRepo();
    const { baseRef, headRef } = commitSharedReleaseToolingChange(repoDir);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toStrictEqual([]);
  });
});

describe("resolveSelectedClawHubPublishablePluginPackages", () => {
  it("selects all publishable plugins when shared release tooling changes", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two"],
    });
    const { baseRef, headRef } = commitSharedReleaseToolingChange(repoDir);

    const selected = resolveSelectedClawHubPublishablePluginPackages({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(selected.map((plugin) => plugin.extensionId)).toEqual(["demo-plugin", "demo-two"]);
  });

  it("selects all publishable plugins when the shared setup action changes", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two"],
    });
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    mkdirSync(join(repoDir, ".github", "actions", "setup-node-env"), { recursive: true });
    writeFileSync(
      join(repoDir, ".github", "actions", "setup-node-env", "action.yml"),
      "name: setup-node-env\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "shared helpers",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const selected = resolveSelectedClawHubPublishablePluginPackages({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(selected.map((plugin) => plugin.extensionId)).toEqual(["demo-plugin", "demo-two"]);
  });
});

describe("collectPluginClawHubReleasePlan", () => {
  it("keeps existing trusted packages with missing versions as normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl, requests } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher).toStrictEqual([]);
    expect(requests).toEqual([
      "/api/v1/packages/%40openclaw%2Fdemo-plugin",
      "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher",
      "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1",
    ]);
  });

  it("cancels unused ClawHub package and version response bodies", async () => {
    const repoDir = createTempPluginRepo();
    const canceled: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);

      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled.push("package");
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled.push("version");
            },
          }),
          { status: 404 },
        );
      }

      throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
    };

    await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(canceled).toEqual(["package", "version"]);
  });

  it("retries a rate-limited trusted publisher lookup", async () => {
    const repoDir = createTempPluginRepo();
    let trustedPublisherRequests = 0;
    let rateLimitedBodyCanceled = false;
    let firstTrustedPublisherRequestAt: number | undefined;
    let retryTrustedPublisherRequestAt: number | undefined;
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          firstTrustedPublisherRequestAt = Date.now();
          return new Response(
            new ReadableStream({
              cancel() {
                rateLimitedBodyCanceled = true;
              },
            }),
            { status: 429 },
          );
        }
        retryTrustedPublisherRequestAt = Date.now();
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(trustedPublisherRequests).toBe(2);
    expect(rateLimitedBodyCanceled).toBe(true);
    expect(retryTrustedPublisherRequestAt).toBeGreaterThanOrEqual(
      (firstTrustedPublisherRequestAt ?? Number.POSITIVE_INFINITY) + 900,
    );
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it("honors an HTTP-date Retry-After header", async () => {
    const repoDir = createTempPluginRepo();
    const retryAfter = "Wed, 21 Oct 2030 07:28:00 GMT";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(retryAfter) - 1_000);
    let trustedPublisherRequests = 0;
    let firstTrustedPublisherRequestAt: number | undefined;
    let retryTrustedPublisherRequestAt: number | undefined;
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          firstTrustedPublisherRequestAt = performance.now();
          return new Response("", { status: 429, headers: { "retry-after": retryAfter } });
        }
        retryTrustedPublisherRequestAt = performance.now();
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    try {
      await collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(trustedPublisherRequests).toBe(2);
    expect(retryTrustedPublisherRequestAt).toBeGreaterThanOrEqual(
      (firstTrustedPublisherRequestAt ?? Number.POSITIVE_INFINITY) + 900,
    );
  });

  it("falls back to the bounded retry schedule for an excessive Retry-After header", async () => {
    const repoDir = createTempPluginRepo();
    let trustedPublisherRequests = 0;
    let firstTrustedPublisherRequestAt: number | undefined;
    let retryTrustedPublisherRequestAt: number | undefined;
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          firstTrustedPublisherRequestAt = Date.now();
          return new Response("", { status: 429, headers: { "retry-after": "999999999999" } });
        }
        retryTrustedPublisherRequestAt = Date.now();
        return new Response(
          JSON.stringify({
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(trustedPublisherRequests).toBe(2);
    expect(retryTrustedPublisherRequestAt).toBeGreaterThanOrEqual(
      (firstTrustedPublisherRequestAt ?? Number.POSITIVE_INFINITY) + 900,
    );
  });

  it("routes missing package rows to bootstrap candidates instead of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 404,
        },
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
    expect(plan.bootstrapCandidates[0]).toMatchObject({
      alreadyPublished: false,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
    expect(plan.missingTrustedPublisher).toStrictEqual([]);
  });

  it("routes existing packages without trusted publisher config out of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
    expect(plan.missingTrustedPublisher[0]).toMatchObject({
      alreadyPublished: false,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
  });

  it("keeps ClawHub trusted publisher timeouts active while reading response bodies", async () => {
    const repoDir = createTempPluginRepo();
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
    };

    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("ClawHub request timed out after 5ms");
  });

  it("routes environment-pinned trusted publisher config out of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
              environment: "clawhub-plugin-release",
            },
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
  });

  it("skips versions that already exist on ClawHub", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 200,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
    expect(plan.missingTrustedPublisher[0]).toMatchObject({
      alreadyPublished: true,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
    expect(plan.skippedPublished).toHaveLength(1);
    expect(plan.skippedPublished[0]).toEqual({
      alreadyPublished: true,
      artifactName: "clawhub-package-openclaw-demo-plugin-2026.4.1",
      channel: "stable",
      extensionId: "demo-plugin",
      packageDir: "extensions/demo-plugin",
      packageName: "@openclaw/demo-plugin",
      publishTag: "latest",
      version: "2026.4.1",
    });
  });

  it("plans selected packages without validating unrelated publishable packages", async () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["broken-plugin"],
    });
    writeFileSync(
      join(repoDir, "extensions", "broken-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/broken-plugin",
          version: "2026.4.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl: createClawHubPlanFetch({
        packages: {
          "@openclaw/demo-plugin": {
            status: 200,
            body: {
              package: {},
              owner: {},
            },
          },
        },
        trustedPublishers: {
          "@openclaw/demo-plugin": {
            status: 200,
            body: {
              trustedPublisher: {
                repository: "openclaw/openclaw",
                workflowFilename: "plugin-clawhub-release.yml",
              },
            },
          },
        },
        versions: {
          "@openclaw/demo-plugin@2026.4.1": 404,
        },
      }).fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
    expect(plan.candidates.map((plugin) => plugin.artifactName)).toEqual([
      "clawhub-package-openclaw-demo-plugin-2026.4.1",
    ]);
  });
});

describe("buildOpenClawReleaseClawHubPlan", () => {
  it("emits a dispatch plan that keeps ClawHub children on the release tag", async () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two", "demo-three"],
    });
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
        "@openclaw/demo-two": {
          status: 404,
        },
        "@openclaw/demo-three": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
            },
          },
        },
        "@openclaw/demo-three": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
        "@openclaw/demo-three@2026.4.1": 404,
      },
    });

    const plan = await buildOpenClawReleaseClawHubPlan(
      {
        releaseTag: "v2026.4.1-beta.1",
        releasePublishBranch: "main",
        releasePublishRunId: "12345",
        pluginPublishScope: "all-publishable",
        plugins: [],
      },
      {
        rootDir: repoDir,
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
      },
    );

    expect(plan.clawHubWorkflowRef).toBe("v2026.4.1-beta.1");
    expect(plan.releasePublishBranch).toBe("main");
    expect(plan.normal).toEqual({
      workflow: "plugin-clawhub-release.yml",
      ref: "v2026.4.1-beta.1",
      shouldDispatch: true,
      packages: ["@openclaw/demo-plugin"],
      inputs: {
        publish_scope: "selected",
        plugins: "@openclaw/demo-plugin",
        release_publish_run_id: "12345",
        release_publish_branch: "main",
      },
    });
    expect(plan.bootstrap).toEqual({
      workflow: "plugin-clawhub-new.yml",
      ref: "v2026.4.1-beta.1",
      shouldDispatch: true,
      packages: ["@openclaw/demo-two", "@openclaw/demo-three"],
      inputs: {
        plugins: "@openclaw/demo-two,@openclaw/demo-three",
        release_publish_run_id: "12345",
        release_publish_branch: "main",
      },
    });
    expect(new Set([...plan.normal.packages, ...plan.bootstrap.packages]).size).toBe(3);
    expect(plan.summary).toEqual({
      normalCount: 1,
      bootstrapCount: 2,
      missingTrustedPublisherCount: 1,
      normalPlugins: "@openclaw/demo-plugin",
      bootstrapPlugins: "@openclaw/demo-two,@openclaw/demo-three",
      missingTrustedPlugins: "@openclaw/demo-three",
    });
    expect(plan.verifier).toEqual({
      clawHubWorkflowRef: "v2026.4.1-beta.1",
    });
  });

  it("routes already-published packages missing trusted publisher config to bootstrap repair", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 200,
      },
    });

    const plan = await buildOpenClawReleaseClawHubPlan(
      {
        releaseTag: "v2026.4.1-beta.1",
        releasePublishBranch: "release/2026.4.1",
        releasePublishRunId: "12345",
        pluginPublishScope: "selected",
        plugins: ["@openclaw/demo-plugin"],
      },
      {
        rootDir: repoDir,
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
      },
    );

    expect(plan.normal.shouldDispatch).toBe(false);
    expect(plan.bootstrap).toMatchObject({
      workflow: "plugin-clawhub-new.yml",
      ref: "v2026.4.1-beta.1",
      shouldDispatch: true,
      packages: ["@openclaw/demo-plugin"],
      inputs: {
        plugins: "@openclaw/demo-plugin",
        release_publish_run_id: "12345",
        release_publish_branch: "release/2026.4.1",
      },
    });
    expect(plan.summary).toMatchObject({
      normalCount: 0,
      bootstrapCount: 1,
      missingTrustedPublisherCount: 1,
      bootstrapPlugins: "@openclaw/demo-plugin",
      missingTrustedPlugins: "@openclaw/demo-plugin",
    });
  });

  it("rejects incompatible all-publishable plugin selection args", () => {
    expect(() =>
      parseOpenClawReleaseClawHubPlanArgs([
        "--release-tag",
        "v2026.4.1-beta.1",
        "--release-publish-branch",
        "main",
        "--release-publish-run-id",
        "12345",
        "--plugin-publish-scope",
        "all-publishable",
        "--plugins",
        "@openclaw/demo-plugin",
      ]),
    ).toThrow("plugin-publish-scope=all-publishable must not be combined with --plugins.");
  });
});

describe("buildOpenClawReleaseClawHubRuntimeState", () => {
  it("includes the normal ClawHub run in verifier args when the release waits for it", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: true,
      forceSkipClawHub: false,
      normalRunId: "111",
      bootstrapRunId: "",
      bootstrapCompleted: false,
    });

    expect(state.verifierArgs).toEqual(["--plugin-clawhub-run", "111"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe("- plugin ClawHub bootstrap: not needed");
  });

  it("includes a completed bootstrap run even when there is no normal ClawHub run", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: false,
      forceSkipClawHub: false,
      normalRunId: "",
      bootstrapRunId: "222",
      bootstrapCompleted: true,
    });

    expect(state.verifierArgs).toEqual(["--plugin-clawhub-bootstrap-run", "222"]);
    expect(state.proofLines.normal).toBe("- plugin ClawHub publish: no normal OIDC candidates");
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });

  it("skips ClawHub verification for non-awaited incomplete runs while keeping proof links", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: false,
      forceSkipClawHub: false,
      normalRunId: "111",
      bootstrapRunId: "222",
      bootstrapCompleted: false,
    });

    expect(state.verifierArgs).toEqual(["--skip-clawhub"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: dispatched separately, not awaited by this proof: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: dispatched separately, not awaited by this proof: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });

  it("keeps completed bootstrap run evidence when the normal ClawHub run is not awaited", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: false,
      forceSkipClawHub: false,
      normalRunId: "111",
      bootstrapRunId: "222",
      bootstrapCompleted: true,
    });

    expect(state.verifierArgs).toEqual(["--skip-clawhub", "--plugin-clawhub-bootstrap-run", "222"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: dispatched separately, not awaited by this proof: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });

  it("forces skip-clawhub after a failed child run even if ClawHub runs completed", () => {
    const state = buildOpenClawReleaseClawHubRuntimeState({
      repository: "openclaw/openclaw",
      waitForClawHub: true,
      forceSkipClawHub: true,
      normalRunId: "111",
      bootstrapRunId: "222",
      bootstrapCompleted: true,
    });

    expect(state.verifierArgs).toEqual(["--skip-clawhub"]);
    expect(state.proofLines.normal).toBe(
      "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/111",
    );
    expect(state.proofLines.bootstrap).toBe(
      "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/222",
    );
  });
});

describe("plugin-clawhub-publish.sh", () => {
  it("previews the publish command through the ClawHub CLI dry-run preflight", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
  pack_destination=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pack-destination)
        pack_destination="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  mkdir -p "$pack_destination"
  pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
  printf 'fake tgz\\n' > "$pack_path"
  printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
    );
    chmodSync(clawhubPath, 0o755);

    const output = execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--dry-run",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(output).toContain("Publish command: CLAWHUB_WORKDIR=");
    expect(output).toContain("Resolved ClawPack:");
    const invocations = readFileSync(markerPath, "utf8");
    const resolvedRepoDir = realpathSync(repoDir);
    expect(invocations).toContain(`--workdir ${resolvedRepoDir}`);
    expect(invocations).toContain(
      `package pack ${join(resolvedRepoDir, "extensions/demo-plugin")}`,
    );
    expect(invocations).toContain("package publish ");
    expect(invocations).toContain(".tgz --tags latest");
    expect(invocations).toContain("--dry-run");
  });

  it("passes a manual override reason when trusted publisher repair requires one", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
  pack_destination=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pack-destination)
        pack_destination="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  mkdir -p "$pack_destination"
  pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
  printf 'fake tgz\\n' > "$pack_path"
  printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
    );
    chmodSync(clawhubPath, 0o755);

    execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--publish",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_MANUAL_OVERRIDE_REASON:
            "GitHub Actions trusted publisher repair before OIDC migration",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    const invocations = readFileSync(markerPath, "utf8");
    expect(invocations).toContain("package publish ");
    expect(invocations).toContain(
      "--manual-override-reason GitHub Actions trusted publisher repair before OIDC migration",
    );
  });

  it("packs a reusable workflow artifact without publishing", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const outputDir = join(repoDir, "clawhub-artifacts");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
  shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
  pack_destination=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pack-destination)
        pack_destination="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  mkdir -p "$pack_destination"
  pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
  printf 'fake tgz\\n' > "$pack_path"
  printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
    );
    chmodSync(clawhubPath, 0o755);

    const output = execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--pack",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(output).toContain("Packed ClawPack:");
    expect(existsSync(join(outputDir, "openclaw-demo-plugin-2026.4.1.tgz"))).toBe(true);
    const invocations = readFileSync(markerPath, "utf8");
    expect(invocations).toContain("package pack ");
    expect(invocations).not.toContain("package publish ");
  });
});

describe("collectPluginClawHubReleasePathsFromGitRange", () => {
  it("rejects unsafe git refs", () => {
    const repoDir = createTempPluginRepo();
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    expect(() =>
      collectPluginClawHubReleasePathsFromGitRange({
        rootDir: repoDir,
        gitRange: {
          baseRef: "--not-a-ref",
          headRef,
        },
      }),
    ).toThrow("baseRef must be a normal git ref or commit SHA.");
  });
});

function createTempPluginRepo(
  options: {
    extensionId?: string;
    extraExtensionIds?: string[];
    publishToClawHub?: boolean;
    includeClawHubContract?: boolean;
  } = {},
) {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-clawhub-release-");
  const extensionId = options.extensionId ?? "demo-plugin";
  const extensionIds = [extensionId, ...(options.extraExtensionIds ?? [])];

  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "openclaw-test-root", type: "module" }, null, 2),
  );
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const currentExtensionId of extensionIds) {
    mkdirSync(join(repoDir, "extensions", currentExtensionId), { recursive: true });
    writeFileSync(
      join(repoDir, "extensions", currentExtensionId, "package.json"),
      JSON.stringify(
        {
          name: `@openclaw/${currentExtensionId}`,
          version: "2026.4.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            ...(options.includeClawHubContract === false
              ? {}
              : {
                  compat: {
                    pluginApi: ">=2026.4.1",
                  },
                  build: {
                    openclawVersion: "2026.4.1",
                  },
                }),
            install: {
              npmSpec: `@openclaw/${currentExtensionId}`,
            },
            release: {
              publishToClawHub: options.publishToClawHub ?? true,
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(repoDir, "extensions", currentExtensionId, "index.ts"),
      `export const ${currentExtensionId.replaceAll(/[-.]/g, "_")} = 1;\n`,
    );
    writeFileSync(join(repoDir, "extensions", currentExtensionId, "README.md"), "# Demo plugin\n");
  }

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ]);

  return repoDir;
}

function commitSharedReleaseToolingChange(repoDir: string) {
  const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  writeFileSync(join(repoDir, "scripts", "plugin-clawhub-publish.sh"), "#!/usr/bin/env bash\n");
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "shared tooling",
  ]);
  const headRef = git(repoDir, ["rev-parse", "HEAD"]);

  return { baseRef, headRef };
}

function createClawHubPlanFetch(config: {
  packages: Record<
    string,
    {
      status: number;
      body?: unknown;
    }
  >;
  trustedPublishers?: Record<
    string,
    {
      status: number;
      body?: unknown;
    }
  >;
  versions?: Record<string, number>;
}) {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl);
    requests.push(url.pathname);

    const packageMatch = url.pathname.match(/^\/api\/v1\/packages\/([^/]+)$/u);
    if (packageMatch) {
      const packageName = decodeURIComponent(packageMatch[1]);
      const packageResponse = config.packages[packageName];
      if (!packageResponse) {
        throw new Error(`Unexpected package detail request for ${packageName}`);
      }
      return new Response(JSON.stringify(packageResponse.body ?? {}), {
        status: packageResponse.status,
      });
    }

    const trustedPublisherMatch = url.pathname.match(
      /^\/api\/v1\/packages\/([^/]+)\/trusted-publisher$/u,
    );
    if (trustedPublisherMatch) {
      const packageName = decodeURIComponent(trustedPublisherMatch[1]);
      const trustedPublisherResponse = config.trustedPublishers?.[packageName];
      if (!trustedPublisherResponse) {
        throw new Error(`Unexpected trusted-publisher request for ${packageName}`);
      }
      return new Response(JSON.stringify(trustedPublisherResponse.body ?? {}), {
        status: trustedPublisherResponse.status,
      });
    }

    const versionMatch = url.pathname.match(/^\/api\/v1\/packages\/([^/]+)\/versions\/([^/]+)$/u);
    if (versionMatch) {
      const packageName = decodeURIComponent(versionMatch[1]);
      const version = decodeURIComponent(versionMatch[2]);
      const status = config.versions?.[`${packageName}@${version}`];
      if (!status) {
        throw new Error(`Unexpected version detail request for ${packageName}@${version}`);
      }
      return new Response("{}", { status });
    }

    throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
  };

  return { fetchImpl, requests };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
