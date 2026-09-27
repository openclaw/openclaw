import { execFileSync, spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { collectClawHubPublishablePluginPackages } from "../../scripts/lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "../../scripts/lib/plugin-npm-release.ts";
import { collectExtensionPackageJsonCandidates } from "../../scripts/lib/plugin-publication-candidates.ts";
import {
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  validateReleasePlan,
  type ReleasePlan,
  type ReleasePlanLock,
} from "../../scripts/release-plan-contract.mjs";
import {
  deriveReleasePlanPolicy,
  runReleasePlanProducerOperation,
} from "../../scripts/release-plan-producer-core.mts";
import {
  produceReleasePlan as trustedCheckoutProduceReleasePlan,
  produceVerifiedReleaseInventory as trustedCheckoutProduceVerifiedReleaseInventory,
  verifyReleasePlanLock as trustedCheckoutVerifyReleasePlanLock,
  type MainQualificationValidationIntent,
  type ReleasePlanIntent,
  type ReleasePlanSource,
  type ReleaseInventorySource,
  type VerifiedReleaseInventory,
} from "../../scripts/release-plan-producer.mts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const templateDirs = useAutoCleanupTempDirTracker(afterAll);
let defaultFixture: ReturnType<typeof buildFixtureRepo> | undefined;
const TOOLING_CLOSURE = [
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/categories.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-plan-contract.mjs",
  "scripts/release-validation-intent.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/npm-core-release-packages.json",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/plugin-publication-target.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
];
const TOOLING_ROOT_FILES = ["package.json", "pnpm-lock.yaml"];

function writeFixture(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(root: string, message: string, options: { allowEmpty?: boolean } = {}): string {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      ...(options.allowEmpty ? ["--allow-empty"] : []),
      "-m",
      message,
    ],
    { cwd: root },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function copyToolingClosure(root: string) {
  for (const path of [...TOOLING_CLOSURE, ...TOOLING_ROOT_FILES]) {
    writeFixture(root, path, readFileSync(resolve(path), "utf8"));
  }
}

type FixtureOptions = {
  conflictingPlatformId?: boolean;
  corePackageNameCollision?: boolean;
  duplicateCrossTargetPackageName?: boolean;
  malformedPlugin?: boolean;
  malformedPluginJson?: boolean;
};

function createFixtureRepo(version = "2026.8.1-beta.2", options: FixtureOptions = {}) {
  const root = tempDirs.make("openclaw-release-plan-");
  if (version !== "2026.8.1-beta.2" || Object.keys(options).length > 0) {
    return buildFixtureRepo(root, version, options);
  }
  const template = (defaultFixture ??= buildFixtureRepo(
    templateDirs.make("openclaw-release-plan-template-"),
    version,
    options,
  ));
  // Copy both commits before any case adds YAML, tags, or mutated tooling.
  // Independent files keep those authority and loader faults local to each case.
  cpSync(template.root, root, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  return { ...template, root };
}

function buildFixtureRepo(root: string, version: string, options: FixtureOptions) {
  execFileSync("git", ["init", "-q", "-b", "tooling"], { cwd: root });

  writeFixture(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version,
      dependencies: { "@openclaw/ai": "workspace:*" },
    }),
  );
  for (const [path, name] of [
    ["packages/ai", "@openclaw/ai"],
    ["packages/gateway-client", "@openclaw/gateway-client"],
    ["packages/gateway-protocol", "@openclaw/gateway-protocol"],
  ]) {
    writeFixture(
      root,
      `${path}/package.json`,
      JSON.stringify({
        name,
        version,
        openclaw: { release: { publishToNpm: true } },
      }),
    );
  }
  if (options.corePackageNameCollision) {
    writePublishablePluginFixture(root, {
      extensionId: "shadow-ai",
      packageName: "@openclaw/ai",
      version,
      publishTo: "both",
    });
  } else if (options.duplicateCrossTargetPackageName) {
    writePublishablePluginFixture(root, {
      extensionId: "duplicate-npm",
      packageName: "@openclaw/duplicate",
      version,
      publishTo: "npm",
    });
    writePublishablePluginFixture(root, {
      extensionId: "duplicate-clawhub",
      packageName: "@openclaw/duplicate",
      version,
      publishTo: "clawhub",
    });
  } else if (options.malformedPluginJson) {
    writeFixture(root, "extensions/broken/package.json", "{ not-json\n");
  } else if (options.malformedPlugin) {
    writeFixture(
      root,
      "extensions/broken/package.json",
      JSON.stringify({
        name: "@openclaw/broken",
        version,
        type: "commonjs",
        private: true,
        repository: { type: "git", url: "https://github.com/openclaw/openclaw" },
        openclaw: {
          extensions: ["./index.ts"],
          compat: { pluginApi: `>=${version}` },
          build: { openclawVersion: version },
          install: { npmSpec: "@openclaw/broken" },
          release: { publishToNpm: true },
        },
      }),
    );
  }
  const candidateSha = commit(root, "candidate");
  const candidateRef = `refs/tags/v${version}`;

  writeFixture(
    root,
    ".github/workflows/full-release-validation.yml",
    [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      rerun_group:",
      "        options:",
      "          - package",
      "          - all",
      "          - ci",
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".github/workflows/openclaw-release-publish.yml",
    [
      "name: Release Publish",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          promote_windows_release_assets() {",
      "            dispatch_workflow windows-node-release.yml",
      "          }",
      "          promote_android_release_asset() {",
      '            dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml',
      "          }",
      "          dispatch_workflow plugin-npm-release.yml",
      "  publish_docker:",
      "    uses: ./.github/workflows/docker-release.yml",
      "  publish_vcr:",
      "    uses: ./.github/workflows/vercel-container-registry-publish.yml",
      ...(options.conflictingPlatformId
        ? ["  publish_windows:", "    uses: ./.github/workflows/docker-release.yml"]
        : []),
      "",
    ].join("\n"),
  );
  for (const name of [
    "android-release.yml",
    "docker-release.yml",
    "linux-app-release-request.yml",
    "plugin-npm-release.yml",
    "vercel-container-registry-publish.yml",
    "windows-node-release.yml",
  ]) {
    writeFixture(root, `.github/workflows/${name}`, `name: ${name}\n`);
  }
  copyToolingClosure(root);
  const toolingSha = commit(root, "tooling");
  const toolingFullRef = `refs/tags/release-publish/${toolingSha.slice(0, 12)}-1`;
  return { candidateRef, candidateSha, root, toolingFullRef, toolingSha };
}

function sourceParams(
  fixture: ReturnType<typeof createFixtureRepo>,
  intent: ReleasePlanIntent = "publish",
  validationIntent?: MainQualificationValidationIntent,
): ReleasePlanSource {
  const source = {
    repoRoot: fixture.root,
    candidateSha: fixture.candidateSha,
    candidateRef:
      intent === "diagnostic" || intent === "main-qualification"
        ? fixture.candidateSha
        : fixture.candidateRef,
    toolingSha: fixture.toolingSha,
    toolingFullRef: fixture.toolingFullRef,
    runGh: trustedToolingGh(fixture.toolingFullRef, fixture.toolingSha),
  };
  return (
    intent === "main-qualification"
      ? { ...source, intent, validationIntent }
      : { ...source, intent }
  ) as ReleasePlanSource;
}

function trustedToolingGh(toolingFullRef: string, toolingSha: string) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (
      endpoint ===
      `repos/openclaw/openclaw/git/ref/tags/${toolingFullRef.slice("refs/tags/".length)}`
    ) {
      return JSON.stringify({
        ref: toolingFullRef,
        object: { type: "commit", sha: toolingSha },
      });
    }
    throw new Error(`unexpected GitHub API request: ${args.join(" ")}`);
  };
}

function runCoreOperation(
  request:
    | { operation: "produce" | "produce-lock"; params: ReleasePlanSource }
    | { operation: "produce-inventory"; params: ReleaseInventorySource }
    | { operation: "verify-lock"; lockJson: string; params: ReleasePlanSource },
) {
  return runReleasePlanProducerOperation(request, {
    runGh:
      request.params.runGh ??
      (() => {
        throw new Error("unexpected GitHub API request");
      }),
    parseYamlDocuments: (sources) =>
      sources.map((source) => parse(source)) as [unknown, unknown, unknown],
  });
}

function produceReleasePlan(params: ReleasePlanSource) {
  return runCoreOperation({ operation: "produce", params }) as ReleasePlan;
}

function verifyReleasePlanLock(lockJson: string, params: ReleasePlanSource) {
  return runCoreOperation({ operation: "verify-lock", lockJson, params }) as ReleasePlanLock;
}

type YamlPackageHarnessParams = {
  fixture: ReturnType<typeof createFixtureRepo>;
  packageRoot: string;
  sentinelPath: string;
  tempRoot: string;
};

function runYamlPackageSubprocess(
  options: {
    inventory?: boolean;
    version?: string;
    toolingFullRef?: string;
    identityResponse?: (params: YamlPackageHarnessParams) => string;
    main?: {
      intent: "diagnostic" | "main-qualification";
      validationIntent?: MainQualificationValidationIntent;
      comparisonStatus: string;
    };
    beforeProduce?: (params: YamlPackageHarnessParams) => string;
    environment?: (params: YamlPackageHarnessParams) => Record<string, string>;
    mutate?: (params: YamlPackageHarnessParams) => void;
    mutateTooling?: (fixture: ReturnType<typeof createFixtureRepo>) => void;
    beforeImport?: (params: YamlPackageHarnessParams) => string;
    executionHead?: (fixture: ReturnType<typeof createFixtureRepo>) => string;
    remoteToolingSha?: (params: YamlPackageHarnessParams) => string;
  } = {},
) {
  let fixture = createFixtureRepo(options.version);
  if (options.mutateTooling) {
    options.mutateTooling(fixture);
    const toolingSha = commit(fixture.root, "mutated tooling");
    fixture = {
      ...fixture,
      toolingSha,
      toolingFullRef: `refs/tags/release-publish/${toolingSha.slice(0, 12)}-2`,
    };
  }
  const packageRoot = join(fixture.root, "node_modules/yaml");
  cpSync(dirname(createRequire(import.meta.url).resolve("yaml/package.json")), packageRoot, {
    recursive: true,
  });
  const sentinelPath = join(fixture.root, "yaml-executed");
  const identityRequestsPath = join(fixture.root, "identity-requests.jsonl");
  const tempRoot = join(fixture.root, "yaml-temp");
  mkdirSync(tempRoot);
  const params = { fixture, packageRoot, sentinelPath, tempRoot };
  options.mutate?.(params);
  writeFixture(
    fixture.root,
    "yaml-package-harness.mts",
    `
${options.beforeImport?.(params) ?? ""}
const { produceReleasePlan, produceVerifiedReleaseInventory } = await import("./scripts/release-plan-producer.mts");
${options.beforeProduce?.(params) ?? ""}

const toolingFullRef = ${JSON.stringify(options.toolingFullRef ?? (options.main ? "refs/heads/main" : fixture.toolingFullRef))};
const toolingSha = ${JSON.stringify(fixture.toolingSha)};
const plan = ${options.inventory ? "produceVerifiedReleaseInventory" : "produceReleasePlan"}({
  repoRoot: ${JSON.stringify(fixture.root)},
  ${
    options.inventory
      ? ""
      : `intent: ${JSON.stringify(options.main?.intent ?? "publish")},
  validationIntent: ${JSON.stringify(options.main?.validationIntent)},
  candidateRef: ${JSON.stringify(options.main ? fixture.candidateSha : fixture.candidateRef)},`
  }
  candidateSha: ${JSON.stringify(fixture.candidateSha)},
  toolingSha,
  toolingFullRef,
  runGh: (args) => {
    ${
      options.inventory
        ? `
    process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(identityRequestsPath)}, JSON.stringify(args) + "\\n");
    const expected = toolingFullRef === "refs/heads/main"
      ? ["api", "repos/openclaw/openclaw/compare/" + toolingSha + "...main", "--method", "GET", "--jq", "{status}"]
      : ["api", "repos/openclaw/openclaw/git/ref/" + toolingFullRef.slice("refs/".length), "--method", "GET"];
    if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error("unexpected inventory identity request");
    `
        : ""
    }
    return ${
      options.identityResponse
        ? JSON.stringify(options.identityResponse(params))
        : `JSON.stringify({
    status: ${JSON.stringify(options.main?.comparisonStatus)},
    ref: toolingFullRef,
    object: { type: "commit", sha: ${JSON.stringify(options.remoteToolingSha?.(params) ?? fixture.toolingSha)} },
  })`
    };
  },
});
process.stdout.write(JSON.stringify(plan));
const moduleApi = await import("node:module");
const harnessRequire = moduleApi.createRequire(import.meta.url);
const leakedSnapshotCache = Object.keys(harnessRequire.cache).filter(path =>
  path.includes("openclaw-release-yaml-")
);
if (leakedSnapshotCache.length > 0) {
  throw new Error("verified yaml snapshot leaked into parent require.cache");
}
    `,
  );
  if (options.executionHead) {
    execFileSync("git", ["update-ref", "HEAD", options.executionHead(fixture)], {
      cwd: fixture.root,
    });
  }
  return {
    result: spawnSync(process.execPath, [join(fixture.root, "yaml-package-harness.mts")], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        ...options.environment?.(params),
      },
    }),
    fixture,
    identityRequestsPath,
    packageRoot,
    sentinelPath,
    tempRoot,
  };
}

function yamlTempEntries(root: string) {
  return readdirSync(root).filter((name) => name.startsWith("openclaw-release-yaml-"));
}

describe("release plan producer", () => {
  it.each(["main", "protected"] as const)(
    "produces verified inventory with %s tooling without plan authority",
    (route) => {
      const { result, fixture } = runYamlPackageSubprocess({
        inventory: true,
        ...(route === "main"
          ? {
              main: { intent: "diagnostic", comparisonStatus: "identical" },
            }
          : {}),
      });
      expect(result.status, result.stderr).toBe(0);
      const inventory = JSON.parse(result.stdout) as VerifiedReleaseInventory;
      const params = sourceParams(fixture, "diagnostic");
      if (route === "main") {
        params.toolingFullRef = "refs/heads/main";
        params.runGh = () => JSON.stringify({ status: "identical" });
      }
      const plan = produceReleasePlan(params);
      expect(inventory).toEqual({
        candidateSha: fixture.candidateSha,
        tooling: plan.tooling,
        version: plan.version,
        inventory: plan.inventory,
      });
      expect(() => validateReleasePlan(inventory)).toThrow();
      expect(() => parseReleasePlanLockJson(JSON.stringify(inventory))).toThrow();
    },
  );

  it.each([
    ["refs/heads/tideclaw/alpha/2026-09-13-1200Z", "2026.9.9-alpha.1"],
    ["refs/heads/release/2026.9.9", "2026.9.9"],
    ["refs/heads/extended-stable/2026.8.33", "2026.8.33"],
  ])(
    "verifies canonical %s inventory but retains all existing plan operation restrictions",
    (toolingFullRef, version) => {
      const { result, fixture } = runYamlPackageSubprocess({
        inventory: true,
        version,
        toolingFullRef,
      });
      expect(result.status, result.stderr).toBe(0);
      const inventory = JSON.parse(result.stdout) as VerifiedReleaseInventory;
      expect(inventory).toMatchObject({
        candidateSha: fixture.candidateSha,
        version,
        tooling: { ref: toolingFullRef, sha: fixture.toolingSha },
      });
      expect(Object.keys(inventory).toSorted()).toEqual([
        "candidateSha",
        "inventory",
        "tooling",
        "version",
      ]);
      const params = { ...sourceParams(fixture, "diagnostic"), toolingFullRef };
      for (const operation of ["produce", "produce-lock", "verify-lock"] as const) {
        expect(() => runCoreOperation({ operation, params, lockJson: "{}" })).toThrow(
          "release tooling identity is not trusted main, a protected tag, or a prevalidated branch",
        );
      }
      expect(() => validateReleasePlan(inventory)).toThrow();
      expect(() => parseReleasePlanLockJson(JSON.stringify(inventory))).toThrow();
    },
  );

  it.each([
    [
      "moved",
      ({ fixture }: YamlPackageHarnessParams) =>
        JSON.stringify({
          ref: "refs/heads/tideclaw/alpha/2026-09-13-1200Z",
          object: { type: "commit", sha: fixture.candidateSha },
        }),
    ],
    ["missing", () => "{}"],
    [
      "wrong ref",
      ({ fixture }: YamlPackageHarnessParams) =>
        JSON.stringify({
          ref: "refs/heads/main",
          object: { type: "commit", sha: fixture.toolingSha },
        }),
    ],
    [
      "non-commit",
      ({ fixture }: YamlPackageHarnessParams) =>
        JSON.stringify({
          ref: "refs/heads/tideclaw/alpha/2026-09-13-1200Z",
          object: { type: "tag", sha: fixture.toolingSha },
        }),
    ],
    ["malformed", () => "not JSON"],
  ] as const)(
    "rejects %s Tideclaw inventory identity before YAML execution",
    (_label, identityResponse) => {
      const { result, sentinelPath } = runYamlPackageSubprocess({
        inventory: true,
        version: "2026.9.9-alpha.1",
        toolingFullRef: "refs/heads/tideclaw/alpha/2026-09-13-1200Z",
        identityResponse,
        mutate: ({ packageRoot, sentinelPath: mutationSentinel }) => {
          writeFileSync(
            join(packageRoot, "dist/index.js"),
            `require("node:fs").writeFileSync(${JSON.stringify(mutationSentinel)}, "executed");`,
          );
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("verified release plan child");
      expect(existsSync(sentinelPath)).toBe(false);
    },
  );

  it.each([
    ["refs/heads/topic/alpha", "workflow ref is not a trusted direct"],
    ["refs/heads/tideclaw/alpha/not-a-date", "workflow ref is not a trusted direct"],
    [
      "refs/tags/tideclaw/alpha/2026-09-13-1200Z",
      "release tooling identity must be trusted main or an exact protected tag",
    ],
    ["a".repeat(40), "release tooling identity must be trusted main or an exact protected tag"],
  ])("rejects noncanonical inventory tooling %s", (toolingFullRef, message) => {
    const { result } = runYamlPackageSubprocess({
      inventory: true,
      version: "2026.9.9-alpha.1",
      toolingFullRef,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each([
    "refs/heads/release/../main",
    "refs/heads/release//2026.9.9",
    "refs/heads/release/2026.9.9?other=main",
    "refs/heads/release/2026.9.9#main",
    "refs/heads/release/%2e%2e/main",
    "refs/heads/release/2026.9.9\n",
    `refs/heads/${"a".repeat(257)}`,
  ])("rejects unsafe inventory branch transport %j before GET", (toolingFullRef) => {
    const { result, identityRequestsPath } = runYamlPackageSubprocess({
      inventory: true,
      toolingFullRef,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release tooling identity must be trusted main or an exact protected tag",
    );
    expect(existsSync(identityRequestsPath)).toBe(false);
  });

  describe.each([
    ["refs/heads/release/2026.9.9", "2026.9.9"],
    ["refs/heads/extended-stable/2026.8.33", "2026.8.33"],
  ])("canonical inventory branch %s", (toolingFullRef, version) => {
    it.each(["missing", "moved", "wrong ref", "non-commit", "malformed"])(
      "rejects %s identity before YAML execution",
      (fault) => {
        const { result, sentinelPath, identityRequestsPath } = runYamlPackageSubprocess({
          inventory: true,
          toolingFullRef,
          version,
          identityResponse: ({ fixture }) =>
            fault === "malformed"
              ? "not JSON"
              : JSON.stringify(
                  fault === "missing"
                    ? {}
                    : {
                        ref: fault === "wrong ref" ? "refs/heads/main" : toolingFullRef,
                        object: {
                          type: fault === "non-commit" ? "tag" : "commit",
                          sha: fault === "moved" ? fixture.candidateSha : fixture.toolingSha,
                        },
                      },
                ),
          mutate: ({ packageRoot, sentinelPath: mutationSentinel }) => {
            writeFileSync(
              join(packageRoot, "dist/index.js"),
              `require("node:fs").writeFileSync(${JSON.stringify(mutationSentinel)}, "executed");`,
            );
          },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain("verified release plan child");
        expect(existsSync(sentinelPath)).toBe(false);
        expect(readFileSync(identityRequestsPath, "utf8").trim().split("\n")).toHaveLength(1);
      },
    );

    it("binds the child SHA to the parent's cached branch response", () => {
      const { result, identityRequestsPath } = runYamlPackageSubprocess({
        inventory: true,
        toolingFullRef,
        version,
        mutateTooling: ({ root }) => {
          const path = join(root, "scripts/release-plan-producer-core.mts");
          const original = readFileSync(path, "utf8");
          const start = original.indexOf("const verifiedTooling = verifyReleaseToolingIdentity({");
          expect(start).toBeGreaterThan(0);
          const changed =
            original.slice(0, start) +
            original
              .slice(start)
              .replace("workflowSha: toolingSha,", `workflowSha: "${"f".repeat(40)}",`);
          expect(changed).not.toBe(original);
          writeFileSync(path, changed);
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prevalidated release tooling branch");
      expect(readFileSync(identityRequestsPath, "utf8").trim().split("\n")).toHaveLength(1);
    });
  });

  it.each(["2026.9.9", "2026.9.9-beta.1"])(
    "rejects non-alpha %s on Tideclaw inventory",
    (version) => {
      const { result } = runYamlPackageSubprocess({
        inventory: true,
        version,
        toolingFullRef: "refs/heads/tideclaw/alpha/2026-09-13-1200Z",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Tideclaw inventory requires an alpha candidate");
    },
  );

  it.each(["candidateSha", "toolingSha"] as const)("rejects non-exact inventory %s", (field) => {
    const fixture = createFixtureRepo();
    const params = { ...sourceParams(fixture), [field]: "main" };
    expect(() => runCoreOperation({ operation: "produce-inventory", params })).toThrow(
      `${field === "candidateSha" ? "candidate" : "tooling"} SHA must be an exact lowercase 40-character commit SHA`,
    );
  });

  it.each([
    [
      "ref",
      'workflowRef: "tideclaw/alpha/2026-09-13-1201Z",',
      'workflowFullRef: "refs/heads/tideclaw/alpha/2026-09-13-1201Z",',
      "prevalidated release tooling branch is missing or unreadable",
    ],
    [
      "SHA",
      "workflowRef: toolingRef,",
      "workflowFullRef: toolingFullRef,",
      "prevalidated release tooling branch",
    ],
  ])(
    "binds inventory child %s to the parent's cached identity",
    (field, refLine, fullRefLine, message) => {
      const { result } = runYamlPackageSubprocess({
        inventory: true,
        version: "2026.9.9-alpha.1",
        toolingFullRef: "refs/heads/tideclaw/alpha/2026-09-13-1200Z",
        mutateTooling: ({ root }) => {
          const path = join(root, "scripts/release-plan-producer-core.mts");
          const original = readFileSync(path, "utf8");
          const start = original.indexOf("const verifiedTooling = verifyReleaseToolingIdentity({");
          expect(start).toBeGreaterThan(0);
          const changed =
            original.slice(0, start) +
            original
              .slice(start)
              .replace("workflowRef: toolingRef,", refLine)
              .replace("workflowFullRef: toolingFullRef,", fullRefLine)
              .replace(
                "workflowSha: toolingSha,",
                field === "SHA" ? `workflowSha: "${"f".repeat(40)}",` : "workflowSha: toolingSha,",
              );
          expect(changed).not.toBe(original);
          writeFileSync(path, changed);
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    },
  );

  it("does not accept caller-provided prevalidated authority for inventory", () => {
    const params = {
      ...sourceParams(createFixtureRepo()),
      toolingFullRef: "refs/heads/topic/alpha",
      allowPrevalidatedRef: true,
    };
    expect(() => runCoreOperation({ operation: "produce-inventory", params })).toThrow(
      "workflow ref is not a trusted direct",
    );
  });

  it("refuses unknown producer operations instead of producing a lock", () => {
    const params = sourceParams(createFixtureRepo());
    expect(() =>
      runCoreOperation({
        operation: "unknown" as "produce-lock",
        params,
      }),
    ).toThrow("unsupported release plan producer operation");
  });

  it("rejects invalid identity through the verified child dispatcher", () => {
    expect(() =>
      runReleasePlanProducerOperation(
        {
          operation: "produce",
          params: {
            candidateRef: "refs/tags/v2026.8.1-beta.2",
            candidateSha: "not-a-sha",
            intent: "publish",
            toolingFullRef: "refs/heads/main",
            toolingSha: "f".repeat(40),
          },
        },
        {
          parseYamlDocuments: () => [{}, {}, {}],
          runGh: () => {
            throw new Error("unexpected GitHub request");
          },
        },
      ),
    ).toThrow("candidate SHA must be an exact lowercase 40-character commit SHA");
  });

  it("derives purpose, profile, tag, and soak from the canonical version parser", () => {
    expect(deriveReleasePlanPolicy("publish", "2026.8.1-beta.2")).toEqual({
      intent: "release-beta",
      profile: "beta",
      publishable: true,
      purpose: "beta-publish",
      soak: false,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("publish", "2026.8.1")).toEqual({
      intent: "release-stable",
      profile: "stable",
      publishable: true,
      purpose: "stable-publish",
      soak: true,
      tag: "v2026.8.1",
    });
    expect(deriveReleasePlanPolicy("postpublish-confidence", "2026.8.1-beta.2")).toEqual({
      intent: "diagnostic-full",
      profile: "full",
      publishable: false,
      purpose: "postpublish-confidence",
      soak: true,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("diagnostic", "2026.8.1-beta.2")).toEqual({
      intent: "diagnostic-full",
      profile: "full",
      publishable: false,
      purpose: "diagnostic",
      soak: true,
      tag: null,
    });
    expect(() => deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2")).toThrow(
      "requires an explicit validation intent",
    );
    expect(deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2", "main-daily")).toEqual({
      intent: "main-daily",
      profile: "beta",
      publishable: false,
      purpose: "main-qualification",
      soak: false,
      tag: null,
    });
    expect(deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2", "main-weekly")).toEqual(
      {
        intent: "main-weekly",
        profile: "full",
        publishable: false,
        purpose: "main-qualification",
        soak: true,
        tag: null,
      },
    );
    expect(() => deriveReleasePlanPolicy("publish", "2026.08.1")).toThrow(
      "unsupported release version",
    );
    expect(() =>
      deriveReleasePlanPolicy("unexpected" as ReleasePlanIntent, "2026.8.1-beta.2"),
    ).toThrow("unsupported release plan intent");
  });

  it("reads candidate inventory and tooling policy from genuinely different commits", () => {
    const fixture = createFixtureRepo();
    expect(fixture.candidateSha).not.toBe(fixture.toolingSha);
    expect(() =>
      execFileSync("git", ["cat-file", "-e", fixture.candidateRef], {
        cwd: fixture.root,
        stdio: "ignore",
      }),
    ).toThrow();
    expect(() =>
      execFileSync(
        "git",
        ["cat-file", "-e", `${fixture.candidateSha}:scripts/release-plan-producer.mts`],
        { cwd: fixture.root, stdio: "ignore" },
      ),
    ).toThrow();
    expect(
      execFileSync(
        "git",
        ["cat-file", "-e", `${fixture.toolingSha}:scripts/release-plan-producer.mts`],
        { cwd: fixture.root, stdio: "ignore" },
      ),
    ).toBeNull();
    expect(() =>
      execFileSync("git", ["cat-file", "-e", fixture.toolingFullRef], {
        cwd: fixture.root,
        stdio: "ignore",
      }),
    ).toThrow();

    const plan = produceReleasePlan(sourceParams(fixture));
    expect(plan).toMatchObject({
      candidate_sha: fixture.candidateSha,
      purpose: "beta-publish",
      release_id: "2026.8.1-beta.2",
      tag: "v2026.8.1-beta.2",
      target_context_ref: fixture.candidateRef,
      version: "2026.8.1-beta.2",
    });
    expect(plan.tooling).toMatchObject({
      ref: fixture.toolingFullRef,
      sha: fixture.toolingSha,
    });
    expect(plan.validation).toEqual({
      allowed_groups: ["all", "ci", "package"],
      intent: "release-beta",
      profile: "beta",
      soak: false,
    });
    expect(plan.inventory.packages).toEqual([
      { name: "@openclaw/ai", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "@openclaw/gateway-client", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "@openclaw/gateway-protocol", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "openclaw", targets: ["npm"], version: "2026.8.1-beta.2" },
    ]);
    expect(plan.inventory.platforms).toEqual([
      { id: "android", source: ".github/workflows/android-release.yml" },
      { id: "docker", source: ".github/workflows/docker-release.yml" },
      {
        id: "vcr",
        source: ".github/workflows/vercel-container-registry-publish.yml",
      },
      { id: "windows", source: ".github/workflows/windows-node-release.yml" },
    ]);
  });

  it("ignores large runtime trees when collecting candidate metadata", () => {
    const fixture = createFixtureRepo();
    const params = sourceParams(fixture);
    const expected = produceReleasePlan(params).inventory;
    const git = (args: string[], input?: string) =>
      execFileSync(
        "git",
        ["-c", "user.name=OpenClaw Test", "-c", "user.email=test@example.invalid", ...args],
        { cwd: fixture.root, encoding: "utf8", input },
      ).trim();
    const blob = git(["hash-object", "-w", "--stdin"], "");
    // Git objects reproduce the >1 MiB listing without creating thousands of files.
    const runtimeTree = git(
      ["mktree"],
      Array.from(
        { length: 6000 },
        (_, index) => `100644 blob ${blob}\truntime-${index}-${"x".repeat(180)}.ts\n`,
      ).join(""),
    );
    const directoryLeaves = git(
      ["mktree"],
      `040000 tree ${runtimeTree}\tpackage.json\n040000 tree ${runtimeTree}\tREADME.md\n`,
    );
    const pluginsTree = git(
      ["mktree"],
      `040000 tree ${runtimeTree}\tnoise\n040000 tree ${directoryLeaves}\tdirectory-leaves\n120000 blob ${blob}\tlinked-noise\n`,
    );
    const rootTree = git(
      ["mktree"],
      `${git(["ls-tree", fixture.candidateSha])}\n040000 tree ${pluginsTree}\textensions\n`,
    );
    const candidateSha = git([
      "commit-tree",
      rootTree,
      "-p",
      fixture.candidateSha,
      "-m",
      "runtime",
    ]);
    expect(produceReleasePlan({ ...params, candidateSha }).inventory).toEqual(expected);
  });

  it.each([
    "package.json",
    "packages/ai/package.json",
    "extensions/linked/package.json",
    "extensions/linked/README.md",
  ])("rejects candidate metadata symlinks at %s", (path) => {
    const fixture = createFixtureRepo();
    const target = join(fixture.root, path);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    symlinkSync("must-not-be-read", target);
    const candidateSha = commit(fixture.root, "linked metadata");
    expect(() => produceReleasePlan({ ...sourceParams(fixture), candidateSha })).toThrow(
      "candidate package inventory must not contain symbolic links",
    );
  });

  it.each([
    ["package.json", "100644", true, Buffer.from([0xff])],
    ["README.md", "100644", true, Buffer.from([0xff])],
    ["runtime.ts", "100644", false, Buffer.from([0xff])],
    ["package.json", "160000", false, Buffer.from([0xff])],
    ["README.md", "100644", false, Buffer.from("tab\tname")],
  ] as const)(
    "preserves candidate metadata path bytes: %s/%s/%s",
    (name, mode, rejectsPath, directory) => {
      const fixture = createFixtureRepo();
      const expected = produceReleasePlan(sourceParams(fixture)).inventory;
      const tree = (input: Buffer) =>
        execFileSync("git", ["mktree", "-z"], {
          cwd: fixture.root,
          input,
          encoding: "utf8",
        }).trim();
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: fixture.root,
        input: "outside-inventory",
        encoding: "utf8",
      }).trim();
      const entry =
        mode === "160000" ? `160000 commit ${fixture.candidateSha}` : `${mode} blob ${blob}`;
      const child = tree(Buffer.from(`${entry}\t${name}\0`));
      const extensions = tree(
        Buffer.concat([Buffer.from(`040000 tree ${child}\tname-`), directory, Buffer.from([0])]),
      );
      const candidateTree = tree(
        Buffer.concat([
          execFileSync("git", ["ls-tree", "-z", fixture.candidateSha], { cwd: fixture.root }),
          Buffer.from(`040000 tree ${extensions}\textensions\0`),
        ]),
      );
      fixture.candidateSha = execFileSync(
        "git",
        [
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@example.invalid",
          "commit-tree",
          candidateTree,
          "-p",
          fixture.candidateSha,
          "-m",
          "candidate with byte paths",
        ],
        { cwd: fixture.root, encoding: "utf8" },
      ).trim();
      if (rejectsPath) {
        expect(() => produceReleasePlan(sourceParams(fixture))).toThrow();
      } else {
        expect(produceReleasePlan(sourceParams(fixture)).inventory).toEqual(expected);
      }
    },
  );

  it("requires the final tag only for postpublish confidence", () => {
    const fixture = createFixtureRepo();
    expect(produceReleasePlan(sourceParams(fixture))).toMatchObject({
      purpose: "beta-publish",
      target_context_ref: fixture.candidateRef,
    });
    expect(() => produceReleasePlan(sourceParams(fixture, "postpublish-confidence"))).toThrow(
      "published candidate tag does not resolve",
    );

    execFileSync(
      "git",
      ["tag", fixture.candidateRef.slice("refs/tags/".length), fixture.candidateSha],
      {
        cwd: fixture.root,
      },
    );
    expect(produceReleasePlan(sourceParams(fixture, "postpublish-confidence"))).toMatchObject({
      purpose: "postpublish-confidence",
      target_context_ref: fixture.candidateRef,
      validation: {
        intent: "diagnostic-full",
        profile: "full",
        soak: true,
      },
    });
  });

  it("produces tagless diagnostics from protected tooling", () => {
    const fixture = createFixtureRepo();
    expect(produceReleasePlan(sourceParams(fixture, "diagnostic"))).toMatchObject({
      candidate_sha: fixture.candidateSha,
      purpose: "diagnostic",
      tag: null,
      target_context_ref: fixture.candidateSha,
      tooling: {
        ref: fixture.toolingFullRef,
        sha: fixture.toolingSha,
      },
      validation: {
        intent: "diagnostic-full",
        profile: "full",
        soak: true,
      },
    });
  });

  it.each([
    ["diagnostic", undefined, "ahead", "diagnostic-full", "full", true],
    ["main-qualification", "main-daily", "identical", "main-daily", "beta", false],
    ["main-qualification", "main-weekly", "ahead", "main-weekly", "full", true],
  ] as const)(
    "produces trusted-main %s/%s with %s ancestry through the verified child",
    (intent, validationIntent, comparisonStatus, expectedIntent, profile, soak) => {
      const { result, fixture } = runYamlPackageSubprocess({
        main: { intent, validationIntent, comparisonStatus },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        candidate_sha: fixture.candidateSha,
        purpose: intent,
        tag: null,
        target_context_ref: fixture.candidateSha,
        tooling: { ref: "refs/heads/main", sha: fixture.toolingSha },
        validation: {
          intent: expectedIntent,
          profile,
          soak,
          allowed_groups: ["all", "ci", "package"],
        },
      });
    },
  );

  it("rejects diverged main ancestry before the verified child", () => {
    const { result } = runYamlPackageSubprocess({
      main: { intent: "diagnostic", comparisonStatus: "diverged" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main release tooling SHA is not reachable from current main");
  });

  it("rejects an uncached request from verified tooling", () => {
    const { result } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        const corePath = join(fixture.root, "scripts/release-plan-producer-core.mts");
        writeFileSync(
          corePath,
          readFileSync(corePath, "utf8").replace(
            "const params = { ...request.params, runGh: runtime.runGh };",
            'runtime.runGh(["api", "repos/openclaw/openclaw"]);\nconst params = { ...request.params, runGh: runtime.runGh };',
          ),
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified child rejected an uncached GitHub request");
  });

  it("requires exact candidate and tooling identity instead of checkout HEAD", () => {
    const fixture = createFixtureRepo();
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateSha: "f".repeat(40) }),
    ).toThrow("candidate SHA does not resolve");
    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        runGh: trustedToolingGh(fixture.toolingFullRef, fixture.candidateSha),
      }),
    ).toThrow(
      "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA",
    );
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateRef: "refs/heads/tooling" }),
    ).toThrow("candidate ref must be");
  });

  it("rejects a locally forged protected tooling tag that GitHub does not own", () => {
    const fixture = createFixtureRepo();
    const forgedFullRef = `refs/tags/release-publish/${fixture.toolingSha.slice(0, 12)}-999`;
    execFileSync("git", ["tag", forgedFullRef.slice("refs/tags/".length), fixture.toolingSha], {
      cwd: fixture.root,
    });

    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        toolingFullRef: forgedFullRef,
        runGh: () => {
          throw new Error("HTTP 404");
        },
      }),
    ).toThrow("protected release tooling tag is missing or unreadable");
  });

  it("rejects a caller producer that differs from the exact tooling commit", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ fixture }) => {
        const producerPath = join(fixture.root, "scripts/release-plan-producer.mts");
        writeFileSync(producerPath, `${readFileSync(producerPath, "utf8")}\n// ambient mismatch\n`);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling bootstrap differs from tooling SHA");
  });

  it("rejects a byte-identical bootstrap launched from the candidate checkout", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      executionHead: (fixture) => fixture.candidateSha,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling bootstrap checkout HEAD must equal tooling SHA");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("exports bootstrap operations for trusted-checkout callers", () => {
    expect(trustedCheckoutProduceReleasePlan).toBeTypeOf("function");
    expect(trustedCheckoutProduceVerifiedReleaseInventory).toBeTypeOf("function");
    expect(trustedCheckoutVerifyReleasePlanLock).toBeTypeOf("function");
  });

  it("rejects a forged remote tooling SHA before executing ambient tooling", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ fixture, sentinelPath: sentinel }) => {
        writeFixture(
          fixture.root,
          "scripts/release-plan-producer-core.mts",
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ambient-core");\n`,
        );
      },
      remoteToolingSha: ({ fixture }) => fixture.candidateSha,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA",
    );
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("ignores uncommitted ambient tooling after verifying the exact tooling commit", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ fixture, sentinelPath: sentinel }) => {
        writeFixture(
          fixture.root,
          "scripts/release-plan-producer-core.mts",
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ambient-core");\n`,
        );
      },
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects a symlinked tooling closure before executing its target", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        const targetPath = join(fixture.root, "scripts/release-plan-producer-core.mts");
        const sentinelTarget = join(fixture.root, "scripts/release-plan-producer-evil.mts");
        writeFileSync(
          sentinelTarget,
          `require("node:fs").writeFileSync(${JSON.stringify(join(fixture.root, "yaml-executed"))}, "linked-core");\n`,
        );
        unlinkSync(targetPath);
        symlinkSync("release-plan-producer-evil.mts", targetPath);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling closure path must be a regular Git blob");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects package imports in the retained tooling closure before execution", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        const corePath = join(fixture.root, "scripts/release-plan-producer-core.mts");
        writeFileSync(
          corePath,
          `import "yaml";\nrequire("node:fs").writeFileSync(${JSON.stringify(join(fixture.root, "yaml-executed"))}, "bare-import");\n${readFileSync(corePath, "utf8")}`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling closure contains an unowned import");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects ambiguous tooling aliases before execution", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        writeFixture(
          fixture.root,
          "scripts/lib/release-version.mts",
          `require("node:fs").writeFileSync(${JSON.stringify(join(fixture.root, "yaml-executed"))}, "ambiguous-alias");\n`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling import must resolve to one unambiguous file");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects foreign yaml resolved from a distinct execution root", () => {
    const fixture = createFixtureRepo();
    writeFixture(
      fixture.root,
      "node_modules/yaml/package.json",
      JSON.stringify({
        name: "yaml",
        version: "9.9.9",
        type: "commonjs",
        main: "./index.cjs",
        exports: {
          ".": "./index.cjs",
          "./package.json": "./package.json",
        },
      }),
    );
    writeFixture(
      fixture.root,
      "node_modules/yaml/index.cjs",
      `
exports.parse = source => {
  if (source.includes("rerun_group")) {
    return { on: { workflow_dispatch: { inputs: { rerun_group: { options: ["package", "all", "ci"] } } } } };
  }
  return {
    jobs: {
      publish_docker: { uses: "./.github/workflows/docker-release.yml" },
      publish_vcr: { uses: "./.github/workflows/vercel-container-registry-publish.yml" }
    }
  };
};
`,
    );
    writeFixture(
      fixture.root,
      "foreign-yaml-harness.mts",
      `
import { produceReleasePlan } from "./scripts/release-plan-producer.mts";

const toolingFullRef = ${JSON.stringify(fixture.toolingFullRef)};
const toolingSha = ${JSON.stringify(fixture.toolingSha)};
produceReleasePlan({
  repoRoot: ${JSON.stringify(fixture.root)},
  intent: "publish",
  candidateSha: ${JSON.stringify(fixture.candidateSha)},
  candidateRef: ${JSON.stringify(fixture.candidateRef)},
  toolingSha,
  toolingFullRef,
  runGh: () => JSON.stringify({
    ref: toolingFullRef,
    object: { type: "commit", sha: toolingSha },
  }),
});
`,
    );
    const result = spawnSync(process.execPath, [join(fixture.root, "foreign-yaml-harness.mts")], {
      cwd: fixture.root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
  });

  it.each([false, true])(
    "accepts pinned yaml package bytes (installer metadata=%s)",
    (installerMetadata) => {
      const { result, tempRoot, sentinelPath } = runYamlPackageSubprocess({
        mutate: ({ packageRoot, sentinelPath: installerSentinelPath }) => {
          const installedDependencies = join(packageRoot, "node_modules");
          rmSync(installedDependencies, { recursive: true, force: true });
          if (installerMetadata) {
            mkdirSync(join(installedDependencies, ".bin"), { recursive: true });
            writeFileSync(
              join(installedDependencies, ".bin/yaml"),
              `require("node:fs").writeFileSync(${JSON.stringify(installerSentinelPath)}, "executed");\n`,
            );
            symlinkSync("must-not-be-read", join(installedDependencies, "foreign-package"));
          }
        },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(yamlTempEntries(tempRoot)).toEqual([]);
      expect(existsSync(sentinelPath)).toBe(false);
    },
  );

  it("rejects a changed yaml entry before executing it", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ packageRoot, sentinelPath: sentinel }) => {
        const entryPath = join(packageRoot, "dist/index.js");
        writeFileSync(
          entryPath,
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\n${readFileSync(entryPath, "utf8")}`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects a changed yaml transitive module before execution", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ packageRoot, sentinelPath: sentinel }) => {
        const transitivePath = join(packageRoot, "dist/public-api.js");
        writeFileSync(
          transitivePath,
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\n${readFileSync(transitivePath, "utf8")}`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects internal yaml package symlinks", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ packageRoot }) => {
        const transitivePath = join(packageRoot, "dist/public-api.js");
        unlinkSync(transitivePath);
        symlinkSync("index.js", transitivePath);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed yaml package must not contain symbolic links");
  });

  it("rejects extra yaml package files", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ packageRoot }) => {
        writeFileSync(join(packageRoot, "unexpected.js"), "module.exports = {};\n");
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
  });

  it("rejects missing yaml transitive files through tree attestation", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ packageRoot }) => {
        rmSync(join(packageRoot, "dist/public-api.js"));
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
  });

  it("ignores poisoned direct yaml require cache entries", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      beforeProduce: ({ sentinelPath: sentinel }) => `
const cacheModule = await import("node:module");
const cacheFs = await import("node:fs");
const cacheRequire = cacheModule.createRequire(import.meta.url);
const ambientEntry = cacheRequire.resolve("yaml");
cacheRequire(ambientEntry);
cacheRequire.cache[ambientEntry].exports = {
  parse() {
    cacheFs.writeFileSync(${JSON.stringify(sentinel)}, "direct-cache");
    return {};
  }
};
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("ignores poisoned transitive yaml require cache entries", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      beforeProduce: ({ sentinelPath: sentinel }) => `
const cacheModule = await import("node:module");
const cacheFs = await import("node:fs");
const cachePath = await import("node:path");
const cacheRequire = cacheModule.createRequire(import.meta.url);
const ambientEntry = cacheRequire.resolve("yaml");
cacheRequire(ambientEntry);
const publicApiPath = cachePath.join(cachePath.dirname(ambientEntry), "public-api.js");
cacheRequire.cache[publicApiPath].exports = {
  parse() {
    cacheFs.writeFileSync(${JSON.stringify(sentinel)}, "transitive-cache");
    return {};
  },
  parseAllDocuments() {},
  parseDocument() {},
  stringify() {}
};
delete cacheRequire.cache[ambientEntry];
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("ignores parent yaml Module extension hooks", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      beforeProduce: ({ sentinelPath: sentinel }) => `
const hookModule = (await import("node:module")).createRequire(import.meta.url)("node:module");
const hookFs = await import("node:fs");
const originalJsLoader = hookModule._extensions[".js"];
hookModule._extensions[".js"] = function(module, filename) {
  if (filename.includes("/yaml/") || filename.includes("openclaw-release-yaml-")) {
    hookFs.writeFileSync(${JSON.stringify(sentinel)}, "extension-hook");
  }
  return originalJsLoader(module, filename);
};
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("does not inherit yaml NODE_OPTIONS or NODE_PATH loaders", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ fixture, sentinelPath: sentinel }) => {
        writeFixture(
          fixture.root,
          "yaml-preload.cjs",
          `
if (process.argv.some(value => value.includes("__openclaw_verified_yaml__"))) {
  require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "node-options");
}
`,
        );
        writeFixture(
          fixture.root,
          "evil-node-path/yaml/index.js",
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "node-path");`,
        );
      },
      environment: ({ fixture }) => ({
        NODE_OPTIONS: `--require=${join(fixture.root, "yaml-preload.cjs")}`,
        NODE_PATH: join(fixture.root, "evil-node-path"),
      }),
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("accepts exact-byte yaml hardlinks without creating a snapshot", () => {
    const { result, tempRoot } = runYamlPackageSubprocess({
      mutate: ({ fixture, packageRoot }) => {
        const targetPath = join(packageRoot, "dist/public-api.js");
        const linkSource = join(fixture.root, "public-api-hardlink-source.js");
        writeFileSync(linkSource, readFileSync(targetPath));
        unlinkSync(targetPath);
        linkSync(linkSource, targetPath);
        expect(statSync(targetPath).nlink).toBe(2);
      },
    });
    expect(result.status).toBe(0);
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("ignores a same-size ambient yaml replacement after byte retention", () => {
    const mutationPath = "ambient-mutated";
    const { result, sentinelPath, tempRoot } = runYamlPackageSubprocess({
      beforeImport: ({ fixture, packageRoot, sentinelPath: sentinel }) => `
const mutateModule = await import("node:module");
const mutateFs = await import("node:fs");
const mutateChildProcess = mutateModule.createRequire(import.meta.url)("node:child_process");
const originalExecFileSync = mutateChildProcess.execFileSync;
mutateChildProcess.execFileSync = function(command, args, options) {
  if (args?.[0] === "--input-type=module") {
    const entryPath = ${JSON.stringify(join(packageRoot, "dist/index.js"))};
    const original = mutateFs.readFileSync(entryPath, "utf8");
    const malicious =
      'require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ambient");' +
      "module.exports={parse:JSON.parse};";
    mutateFs.writeFileSync(entryPath, malicious.padEnd(original.length, " "));
    mutateFs.writeFileSync(${JSON.stringify(join(fixture.root, mutationPath))}, "done");
  }
  return originalExecFileSync(command, args, options);
};
mutateModule.syncBuiltinESMExports();
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(result.status === 0 ? dirname(sentinelPath) : "", mutationPath))).toBe(
      true,
    );
    expect(existsSync(sentinelPath)).toBe(false);
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("fails malformed combined yaml parsing without creating a snapshot", () => {
    const { result, tempRoot } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        writeFixture(fixture.root, ".github/workflows/full-release-validation.yml", "on: [\n");
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Flow sequence in block collection");
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("rejects malformed publishable plugins while producing the plan", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", { malformedPlugin: true });
    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      /Publishable plugin metadata validation failed:[\s\S]*private must not be true[\s\S]*type must be "module"[\s\S]*README\.md must exist/u,
    );
  });

  it("fails closed on malformed candidate manifests across both publishers and ReleasePlan", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", { malformedPluginJson: true });
    const error = "plugin candidate manifest is malformed JSON: extensions/broken/package.json";
    expect(() => collectPublishablePluginPackages(fixture.root)).toThrow(error);
    expect(() => collectClawHubPublishablePluginPackages(fixture.root)).toThrow(error);
    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(error);
  });

  it("rejects duplicate package names split across npm and ClawHub plugin sources", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      duplicateCrossTargetPackageName: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "package @openclaw/duplicate is declared by multiple plugin sources",
    );
  });

  it("rejects a plugin package name that collides with a core package source", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      corePackageNameCollision: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "package inventory source mismatch for @openclaw/ai: extensions/shadow-ai/package.json and packages/ai/package.json",
    );
  });

  it("rejects conflicting platform publication sources with the same id", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      conflictingPlatformId: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "declares conflicting platform windows: .github/workflows/windows-node-release.yml and .github/workflows/docker-release.yml",
    );
  });

  it("shares current sourced platforms across inventory, plans, and verified locks", () => {
    const fixture = createFixtureRepo();
    for (const path of [
      ".github/workflows/openclaw-release-publish.yml",
      "scripts/lib/release-publish-children.sh",
    ]) {
      writeFixture(fixture.root, path, readFileSync(resolve(path), "utf8"));
    }
    const toolingSha = commit(fixture.root, "current publication source");
    const params = sourceParams({
      ...fixture,
      toolingSha,
      toolingFullRef: `refs/tags/release-publish/${toolingSha.slice(0, 12)}-1`,
    });
    const plan = produceReleasePlan(params);
    const inventory = runCoreOperation({
      operation: "produce-inventory",
      params,
    }) as VerifiedReleaseInventory;
    expect(inventory.inventory).toEqual(plan.inventory);
    expect(plan.inventory.platforms).toEqual([
      { id: "android", source: ".github/workflows/android-release.yml" },
      { id: "docker", source: ".github/workflows/docker-release.yml" },
      { id: "linux", source: ".github/workflows/linux-app-release-request.yml" },
      { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
      { id: "windows", source: ".github/workflows/windows-node-release.yml" },
    ]);
    expect(
      verifyReleasePlanLock(canonicalReleasePlanLockJson(createReleasePlanLock(plan)), params).plan,
    ).toEqual(plan);
    for (const omitted of ["android", "linux", "windows"]) {
      const partial = structuredClone(plan);
      partial.inventory.platforms = partial.inventory.platforms.filter(({ id }) => id !== omitted);
      expect(() =>
        verifyReleasePlanLock(canonicalReleasePlanLockJson(createReleasePlanLock(partial)), params),
      ).toThrow("repository-derived authority");
    }
  });

  it.each([
    "missing",
    "missing-object",
    "symlink",
    "late-source",
    "wrong-source",
    "missing-definition",
    "duplicate-definition",
    "ambiguous-dispatch",
    "conflict",
    "dormant",
    "unlinked",
  ])("reads only unambiguous linked committed platform helpers: %s", (fault) => {
    const fixture = createFixtureRepo();
    const helperPath = "scripts/lib/release-publish-children.sh";
    const workflowPath = ".github/workflows/openclaw-release-publish.yml";
    const helper = readFileSync(resolve(helperPath), "utf8");
    const publisher = parse(readFileSync(resolve(workflowPath), "utf8")) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    for (const step of publisher.jobs.publish_windows?.steps ?? []) {
      if (!step.run?.includes("promote_windows_release_assets")) {
        continue;
      }
      if (fault === "late-source") {
        step.run = step.run
          .replace("source scripts/lib/release-publish-children.sh", "")
          .replace(
            "promote_windows_release_assets",
            "promote_windows_release_assets\nsource scripts/lib/release-publish-children.sh",
          );
      }
      if (fault === "wrong-source") {
        step.run = step.run.replace(
          "source scripts/lib/release-publish-children.sh",
          "source other.sh",
        );
      }
      if (fault === "conflict") {
        step.run =
          "promote_windows_release_assets() {\n  dispatch_workflow docker-release.yml\n}\n" +
          step.run;
      }
    }
    if (fault === "unlinked") {
      for (const id of ["publish_windows", "publish_android", "publish_linux"]) {
        delete publisher.jobs[id];
      }
    }
    writeFixture(fixture.root, workflowPath, stringify(publisher));
    const sentinel = join(fixture.root, "helper-executed");
    let bytes = helper + `\ntouch ${JSON.stringify(sentinel)}\n`;
    if (fault === "missing-definition") {
      bytes = bytes.replace("promote_windows_release_assets()", "promote_other_release_assets()");
    }
    if (fault === "duplicate-definition") {
      bytes += helper;
    }
    if (fault === "ambiguous-dispatch") {
      bytes = bytes.replace(
        "promote_windows_release_assets() {",
        "promote_windows_release_assets() {\n  dispatch_workflow other.yml",
      );
    }
    if (fault === "dormant") {
      bytes += "\npromote_unused_release_assets() {\n  invalid_dormant_definition\n}\n";
    }
    if (fault !== "missing" && fault !== "unlinked") {
      writeFixture(fixture.root, helperPath, bytes);
    }
    if (fault === "symlink") {
      unlinkSync(join(fixture.root, helperPath));
      symlinkSync("npm-core-release-packages.json", join(fixture.root, helperPath));
    }
    const toolingSha = commit(fixture.root, `platform helper ${fault}`);
    if (fault === "missing-object") {
      const oid = execFileSync("git", ["rev-parse", `${toolingSha}:${helperPath}`], {
        cwd: fixture.root,
        encoding: "utf8",
      }).trim();
      unlinkSync(join(fixture.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    }
    const params = sourceParams({
      ...fixture,
      toolingSha,
      toolingFullRef: `refs/tags/release-publish/${toolingSha.slice(0, 12)}-1`,
    });
    if (fault === "dormant" || fault === "unlinked") {
      const ids = produceReleasePlan(params).inventory.platforms.map(({ id }) => id);
      expect(ids).toEqual(
        fault === "unlinked" ? ["docker", "vcr"] : ["android", "docker", "linux", "vcr", "windows"],
      );
    } else {
      expect(() => produceReleasePlan(params)).toThrow(/platform|release-publish-children/u);
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  it("matches the exact current npm and ClawHub publisher inventories", () => {
    const root = tempDirs.make("openclaw-release-plan-current-");
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve("."),
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", resolve("."), root]);
    const candidates = collectExtensionPackageJsonCandidates();
    const pluginMetadataPaths = candidates.flatMap(({ packageDir, readmeText }) => [
      `${packageDir}/package.json`,
      ...(readmeText === undefined ? [] : [`${packageDir}/README.md`]),
    ]);
    // Preserve the exact candidate commit without materializing runtime trees for fixture cleanup.
    execFileSync("git", ["sparse-checkout", "set", "--no-cone", "--stdin"], {
      cwd: root,
      input: [
        ".github/workflows/",
        "packages/*/package.json",
        ...pluginMetadataPaths,
        ...TOOLING_CLOSURE,
        ...TOOLING_ROOT_FILES,
      ]
        .map((path) => `/${path}`)
        .join("\n"),
    });
    execFileSync("git", ["checkout", "-q", "--detach", candidateSha], { cwd: root });
    copyToolingClosure(root);
    const toolingSha = commit(root, "tooling overlay", { allowEmpty: true });
    execFileSync("git", ["update-ref", "refs/heads/main", toolingSha], { cwd: root });
    expect(candidateSha).not.toBe(toolingSha);
    expect(existsSync(join(root, "src"))).toBe(false);
    expect(collectExtensionPackageJsonCandidates(root)).toEqual(candidates);
    expect(
      readdirSync(join(root, "extensions"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .toSorted(),
    ).toEqual(pluginMetadataPaths.toSorted());

    const plan = produceReleasePlan({
      repoRoot: root,
      intent: "main-qualification",
      validationIntent: "main-weekly",
      candidateSha,
      candidateRef: candidateSha,
      toolingSha,
      toolingFullRef: "refs/heads/main",
      runGh: () => JSON.stringify({ status: "identical" }),
    });
    const npmPackages = plan.inventory.packages.filter((entry) => entry.targets.includes("npm"));
    const clawHubPackages = plan.inventory.packages.filter((entry) =>
      entry.targets.includes("clawhub"),
    );
    const coreNpmPackages = [
      "@openclaw/ai",
      "@openclaw/gateway-client",
      "@openclaw/gateway-protocol",
      "openclaw",
    ];
    expect(npmPackages.map((entry) => entry.name).toSorted()).toEqual(
      [
        ...coreNpmPackages,
        ...collectPublishablePluginPackages(root).map((plugin) => plugin.packageName),
      ].toSorted(),
    );
    expect(clawHubPackages.map((entry) => entry.name).toSorted()).toEqual(
      collectClawHubPublishablePluginPackages(root)
        .map((plugin) => plugin.packageName)
        .toSorted(),
    );
  });

  it("rejects recomputed locks with partial groups or bogus inventory", () => {
    const fixture = createFixtureRepo();
    const params = sourceParams(fixture);
    const plan = produceReleasePlan(params);
    const validLock = canonicalReleasePlanLockJson(createReleasePlanLock(plan));
    expect(verifyReleasePlanLock(validLock, params).plan).toEqual(plan);

    const partialGroups = structuredClone(plan);
    partialGroups.validation.allowed_groups = ["all", "ci"];
    const partialPlatforms = structuredClone(plan);
    partialPlatforms.inventory.platforms = partialPlatforms.inventory.platforms.slice(0, -1);
    const bogusPackages = structuredClone(plan);
    bogusPackages.inventory.packages.push({
      name: "zz-not-published",
      targets: ["npm"],
      version: plan.version,
    });
    for (const changed of [partialGroups, partialPlatforms, bogusPackages]) {
      const redigested = canonicalReleasePlanLockJson(createReleasePlanLock(changed));
      expect(() => verifyReleasePlanLock(redigested, params)).toThrow(
        "repository-derived authority",
      );
    }
  });
});
