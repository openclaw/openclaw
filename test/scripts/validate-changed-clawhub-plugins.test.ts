// Changed ClawHub plugin validation tests cover PR-only package validation routing.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublishablePluginPackage } from "../../scripts/lib/plugin-clawhub-release.ts";
import {
  assertNoRemovedClawHubPublishablePackages,
  buildClawHubPackageValidateCommand,
  CLAWHUB_VALIDATE_CLI_PACKAGE,
  collectBaselineClawHubPublishablePluginPackages,
  collectClawHubPluginValidationPathsFromGitRange,
  createChangedClawHubPackageValidatePlan,
  parseValidateChangedClawHubPluginsArgs,
  parseClawHubValidationReport,
  parseClawHubValidationOutput,
} from "../../scripts/validate-changed-clawhub-plugins.ts";

const publishablePlugins: PublishablePluginPackage[] = [
  {
    extensionId: "discord",
    packageDir: "extensions/discord",
    packageName: "@openclaw/discord",
    version: "2026.6.6",
    channel: "stable",
    publishTag: "latest",
  },
  {
    extensionId: "llama-cpp",
    packageDir: "extensions/llama-cpp",
    packageName: "@openclaw/llama-cpp-provider",
    version: "2026.6.6",
    channel: "stable",
    publishTag: "latest",
  },
  {
    extensionId: "msteams",
    packageDir: "extensions/msteams",
    packageName: "@openclaw/msteams",
    version: "2026.6.2",
    channel: "stable",
    publishTag: "latest",
  },
];

describe("createChangedClawHubPackageValidatePlan", () => {
  it("validates only changed ClawHub-publishable plugin packages", () => {
    expect(
      createChangedClawHubPackageValidatePlan({
        plugins: publishablePlugins,
        changedPaths: [
          "extensions/irc/index.ts",
          "extensions/llama-cpp/package.json",
          "docs/plugins/reference/llama-cpp.md",
        ],
      }),
    ).toEqual([
      {
        extensionId: "llama-cpp",
        packageDir: "extensions/llama-cpp",
        packageName: "@openclaw/llama-cpp-provider",
      },
    ]);
  });

  it("ignores generated shrinkwrap-only plugin changes", () => {
    expect(
      createChangedClawHubPackageValidatePlan({
        plugins: publishablePlugins,
        changedPaths: ["extensions/msteams/npm-shrinkwrap.json"],
      }),
    ).toEqual([]);
  });
});

describe("assertNoRemovedClawHubPublishablePackages", () => {
  it("fails when a changed package was ClawHub-publishable at the base ref but is not in the current plan", () => {
    expect(() =>
      assertNoRemovedClawHubPublishablePackages({
        currentPlan: [],
        baselinePlugins: [
          {
            extensionId: "discord",
            packageDir: "extensions/discord",
            packageName: "@openclaw/discord",
          },
        ],
        changedPaths: ["extensions/discord/package.json"],
      }),
    ).toThrow("extensions/discord: was ClawHub-publishable at @openclaw/discord");
  });

  it("allows changed packages that remain visible in the validation plan", () => {
    expect(() =>
      assertNoRemovedClawHubPublishablePackages({
        currentPlan: [
          {
            extensionId: "discord",
            packageDir: "extensions/discord",
            packageName: "@openclaw/discord",
          },
        ],
        baselinePlugins: [
          {
            extensionId: "discord",
            packageDir: "extensions/discord",
            packageName: "@openclaw/discord",
          },
        ],
        changedPaths: ["extensions/discord/package.json"],
      }),
    ).not.toThrow();
  });

  it("ignores generated shrinkwrap-only package changes", () => {
    expect(() =>
      assertNoRemovedClawHubPublishablePackages({
        currentPlan: [],
        baselinePlugins: [
          {
            extensionId: "discord",
            packageDir: "extensions/discord",
            packageName: "@openclaw/discord",
          },
        ],
        changedPaths: ["extensions/discord/npm-shrinkwrap.json"],
      }),
    ).not.toThrow();
  });
});

describe("collectClawHubPluginValidationPathsFromGitRange", () => {
  it("includes delete-only changes inside plugin packages", () => {
    const repoDir = createTempGitRepo();
    mkdirSync(join(repoDir, "extensions", "llama-cpp"), { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "repo" }));
    writeFileSync(join(repoDir, "extensions", "llama-cpp", "index.ts"), "export {};\n");
    commitAll(repoDir, "initial plugin");
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    rmSync(join(repoDir, "extensions", "llama-cpp", "index.ts"));
    commitAll(repoDir, "delete plugin entrypoint");
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    try {
      expect(
        collectClawHubPluginValidationPathsFromGitRange({
          rootDir: repoDir,
          gitRange: { baseRef, headRef },
        }),
      ).toEqual(["extensions/llama-cpp/index.ts"]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("collectBaselineClawHubPublishablePluginPackages", () => {
  it("reads ClawHub-publishable package metadata from the base ref", () => {
    const repoDir = createTempGitRepo();
    mkdirSync(join(repoDir, "extensions", "discord"), { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "repo" }));
    writeFileSync(
      join(repoDir, "extensions", "discord", "package.json"),
      JSON.stringify({
        name: "@openclaw/discord",
        version: "2026.6.6",
        openclaw: { release: { publishToClawHub: true } },
      }),
    );
    commitAll(repoDir, "initial plugin");
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    try {
      expect(
        collectBaselineClawHubPublishablePluginPackages({
          rootDir: repoDir,
          baselineRef: baseRef,
        }),
      ).toEqual([
        {
          extensionId: "discord",
          packageDir: "extensions/discord",
          packageName: "@openclaw/discord",
        },
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("buildClawHubPackageValidateCommand", () => {
  it("uses the pinned ClawHub CLI outside the root install graph", () => {
    const repoRoot = resolve("/tmp/openclaw-checkout");

    expect(
      buildClawHubPackageValidateCommand("extensions/llama-cpp", "/tmp/clawhub-reports", repoRoot),
    ).toEqual({
      command: "pnpm",
      args: [
        "dlx",
        "--config.minimum-release-age=0",
        CLAWHUB_VALIDATE_CLI_PACKAGE,
        "--workdir",
        repoRoot,
        "package",
        "validate",
        "extensions/llama-cpp",
        "--json",
        "--openclaw",
        repoRoot,
        "--out",
        "/tmp/clawhub-reports",
      ],
    });
  });
});

describe("parseValidateChangedClawHubPluginsArgs", () => {
  it("accepts the pnpm script argument separator", () => {
    expect(
      parseValidateChangedClawHubPluginsArgs([
        "--",
        "--base-ref",
        "origin/main",
        "--head-ref",
        "HEAD",
      ]),
    ).toEqual({
      baseRef: "origin/main",
      headRef: "HEAD",
    });
  });
});

function createTempGitRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "openclaw-clawhub-validate-"));
  git(repoDir, ["init", "-b", "main"]);
  return repoDir;
}

function commitAll(repoDir: string, message: string) {
  git(repoDir, ["add", "-A"]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  ]);
}

function git(repoDir: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("parseClawHubValidationOutput", () => {
  it("accepts a clean validation result", () => {
    expect(
      parseClawHubValidationOutput(
        JSON.stringify({ status: "pass", summary: { warningCount: 0, issueCount: 0 } }),
        "extensions/llama-cpp",
      ),
    ).toEqual({ warningCount: 0, errorCount: 0 });
  });

  it("fails PR validation on ClawHub summary warnings", () => {
    expect(() =>
      parseClawHubValidationOutput(
        JSON.stringify({ status: "pass", summary: { warningCount: 1, issueCount: 0 } }),
        "extensions/llama-cpp",
      ),
    ).toThrow("extensions/llama-cpp: ClawHub validation reported 1 warning");
  });

  it("ignores ClawHub core compatibility warnings", () => {
    expect(
      parseClawHubValidationOutput(
        JSON.stringify({
          status: "pass",
          summary: { warningCount: 1, issueCount: 1 },
          issues: [
            {
              code: "channel-env-vars",
              owner: "core",
              decision: "core-compat-adapter",
              issueClass: "deprecation-warning",
            },
          ],
        }),
        "extensions/slack",
      ),
    ).toEqual({ warningCount: 0, errorCount: 0 });
  });

  it("ignores ClawHub core compatibility warnings from warnings arrays", () => {
    expect(
      parseClawHubValidationOutput(
        JSON.stringify({
          status: "pass",
          summary: { warningCount: 1, issueCount: 1 },
          warnings: [
            {
              code: "channel-env-vars",
              owner: "core",
              decision: "core-compat-adapter",
              issueClass: "deprecation-warning",
            },
          ],
        }),
        "extensions/slack",
      ),
    ).toEqual({ warningCount: 0, errorCount: 0 });
  });

  it("keys blocking warnings by code and evidence for baseline comparisons", () => {
    expect(
      parseClawHubValidationReport(
        JSON.stringify({
          status: "pass",
          summary: { warningCount: 1, issueCount: 1 },
          issues: [
            {
              code: "package-min-host-version-drift",
              owner: "plugin",
              decision: "plugin-upstream-fix",
              issueClass: "upstream-metadata",
              evidence: ["buildOpenClawVersion:2026.6.6", "minHostVersion:>=2026.6.2"],
            },
          ],
        }),
        "extensions/llama-cpp",
      ),
    ).toEqual({
      warningCount: 1,
      errorCount: 0,
      blockingWarningKeys: [
        "owner:plugin;code:package-min-host-version-drift;decision:plugin-upstream-fix;issueClass:upstream-metadata;evidence:buildOpenClawVersion:2026.6.6|minHostVersion:>=2026.6.2",
      ],
    });
  });

  it("keys blocking warnings arrays for baseline comparisons", () => {
    expect(
      parseClawHubValidationReport(
        JSON.stringify({
          status: "pass",
          summary: { warningCount: 1, issueCount: 1 },
          warnings: [
            {
              code: "package-install-metadata-incomplete",
              owner: "plugin",
              decision: "plugin-upstream-fix",
              issueClass: "upstream-metadata",
            },
          ],
        }),
        "extensions/llama-cpp",
      ),
    ).toEqual({
      warningCount: 1,
      errorCount: 0,
      blockingWarningKeys: [
        "owner:plugin;code:package-install-metadata-incomplete;decision:plugin-upstream-fix;issueClass:upstream-metadata",
      ],
    });
  });

  it("fails PR validation on package-owned metadata warnings", () => {
    expect(() =>
      parseClawHubValidationOutput(
        JSON.stringify({
          status: "pass",
          summary: { warningCount: 1, issueCount: 1 },
          issues: [
            {
              code: "package-install-metadata-incomplete",
              owner: "plugin",
              decision: "plugin-upstream-fix",
              issueClass: "upstream-metadata",
            },
          ],
        }),
        "extensions/llama-cpp",
      ),
    ).toThrow("extensions/llama-cpp: ClawHub validation reported 1 warning");
  });
});
