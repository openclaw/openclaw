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
import { afterEach, describe, expect, it } from "vitest";
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
      extensionId: "diagnostics-otel",
      packageName: "@openclaw/diagnostics-otel",
    },
    {
      extensionId: "diagnostics-prometheus",
      packageName: "@openclaw/diagnostics-prometheus",
    },
  ] as const;

  it("keeps diagnostics plugins selectable through both ClawHub and npm release paths", () => {
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
            npmSpec?: string;
          };
          release?: {
            publishToClawHub?: boolean;
            publishToNpm?: boolean;
          };
        };
      };

      expect(packageJson.openclaw?.install).toEqual({
        clawhubSpec: `clawhub:${plugin.packageName}`,
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.25",
        npmSpec: plugin.packageName,
      });
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
    expect(plan.missingTrustedPublisher).toStrictEqual([]);
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
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
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
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
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
    JSON.stringify({ name: "openclaw-test-root" }, null, 2),
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
    const url = new URL(String(input));
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
