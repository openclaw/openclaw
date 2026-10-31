import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_PATH_PROFILE,
  findLaneByName,
  parseLaneSelection,
  resolveDockerE2ePlan,
} from "../../scripts/lib/docker-e2e-plan.mts";
import { createFrozenTargetSource } from "../../scripts/lib/frozen-target-source.mjs";
import {
  UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
  listRecordedFirstHopSourceVersions,
  updateFirstHopCompatLaneName,
} from "../../scripts/lib/update-first-hop-lanes.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const orderLanes = <T>(lanes: T[]) => lanes;

function writeFrozenScenarioContract(targetRoot: string, scenarios: string[]): string {
  const assertionsFile = join(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
  mkdirSync(dirname(assertionsFile), { recursive: true });
  writeFileSync(
    assertionsFile,
    [
      `const scenarios = ${JSON.stringify(scenarios)};`,
      'if (process.argv[2] !== "list-scenarios") throw new Error("unknown command");',
      "process.stdout.write(`${JSON.stringify(scenarios)}\\n`);",
    ].join("\n"),
  );
  return assertionsFile;
}

function copyCurrentScenarioMetadata(targetRoot: string) {
  const paths = [
    "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
    "scripts/lib/upgrade-survivor-policy.mjs",
    "scripts/lib/upgrade-survivor-scenarios.json",
  ];
  for (const relative of paths) {
    mkdirSync(dirname(join(targetRoot, relative)), { recursive: true });
    copyFileSync(relative, join(targetRoot, relative));
  }
  return {
    assertionsFile: join(targetRoot, paths[0]!),
    policyFile: join(targetRoot, paths[1]!),
    catalogFile: join(targetRoot, paths[2]!),
  };
}

const firstHopSourceVersions = listRecordedFirstHopSourceVersions();
const sourceFirstHopLaneNames = firstHopSourceVersions.map(updateFirstHopCompatLaneName);
const firstHopLaneNames = [...sourceFirstHopLaneNames, UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE];

function planFor(
  overrides: Partial<Parameters<typeof resolveDockerE2ePlan>[0]> = {},
): ReturnType<typeof resolveDockerE2ePlan>["plan"] {
  return resolveDockerE2ePlan({
    allowFrozenTargetScenarioOmissions: true,
    includeOpenWebUI: false,
    liveMode: "all",
    orderLanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: [],
    timingStore: undefined,
    ...overrides,
  }).plan;
}

function requireFirstLane(plan: ReturnType<typeof planFor>) {
  const [lane] = plan.lanes;
  if (!lane) {
    throw new Error("Expected at least one Docker E2E lane");
  }
  return lane;
}

function summarizeLane(lane: ReturnType<typeof planFor>["lanes"][number]) {
  return {
    command: lane.command,
    imageKind: lane.imageKind,
    live: lane.live,
    name: lane.name,
    resources: lane.resources,
    ...(lane.stateScenario ? { stateScenario: lane.stateScenario } : {}),
    ...(lane.timeoutMs !== undefined ? { timeoutMs: lane.timeoutMs } : {}),
    weight: lane.weight,
  };
}

function trustedUpgradeSurvivorCommand(
  envPrefix = "",
  shellPrelude = "",
  harnessDir = ".",
): string {
  const prefix = envPrefix ? `${envPrefix} ` : "";
  const prelude = shellPrelude ? `${shellPrelude}; ` : "";
  return `OPENCLAW_DOCKER_E2E_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" ${prefix}OPENCLAW_SKIP_DOCKER_BUILD=1 bash -c '${prelude}harness="\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-${harnessDir}}"; OPENCLAW_LIVE_DOCKER_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" bash "$harness/scripts/e2e/upgrade-survivor-docker.sh"'`;
}

function publishedUpgradeSurvivorLane(
  name: string,
  baselineSpec: string,
  scenario?: string,
): ReturnType<typeof summarizeLane> {
  return {
    command: `OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/${name}" OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='${baselineSpec}' ${
      scenario ? `OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='${scenario}' ` : ""
    }${trustedUpgradeSurvivorCommand(
      "OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT=1500s",
      'export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-openclaw@latest}"; export OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-2280s}"',
    )}`,
    imageKind: "bare",
    live: false,
    name,
    resources: ["docker", "npm"],
    stateScenario: "upgrade-survivor",
    timeoutMs: 2_580_000,
    weight: 3,
  };
}

describe("scripts/lib/docker-e2e-plan", () => {
  function commitTarget(root: string) {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return { sha: git("rev-parse", "HEAD"), git };
  }

  it("admits the current frozen catalog for missing-configured-plugin-migration", () => {
    const root = tempDirs.make("openclaw-current-inert-catalog-");
    copyCurrentScenarioMetadata(root);
    copyFileSync("package.json", join(root, "package.json"));
    const { sha } = commitTarget(root);
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "2026.9.2",
      upgradeSurvivorScenarios: "missing-configured-plugin-migration",
      upgradeSurvivorTargetRoot: root,
      frozenTarget: { mode: "inert", source: createFrozenTargetSource(root, sha) },
    });
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "published-upgrade-survivor-2026.9.2-missing-configured-plugin-migration",
    ]);
    expect(plan.omittedUnsupportedLanes).toEqual([]);
  });

  it("rejects execution of the retired Teams JSON migration scenario", () => {
    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: "2026.9.5",
        upgradeSurvivorScenarios: "msteams-polls",
      }),
    ).toThrow("invalid published upgrade survivor scenario");
  });

  it.each(["committed", "unapproved checkout"])(
    "reads declared JSON capabilities without executing its %s modules",
    (mode) => {
      const root = tempDirs.make("openclaw-imported-inert-catalog-");
      const { assertionsFile, policyFile, catalogFile } = copyCurrentScenarioMetadata(root);
      const marker = join(root, "executed");
      const markerCode = `\nimport { writeFileSync as markExecuted } from "node:fs"; markExecuted(${JSON.stringify(marker)}, "executed");\n`;
      for (const file of [assertionsFile, policyFile]) {
        writeFileSync(file, readFileSync(file, "utf8") + markerCode);
      }
      const { sha } = commitTarget(root);
      const source = createFrozenTargetSource(root, sha);
      if (mode === "committed") {
        writeFileSync(catalogFile, "uncommitted catalog must not be read\n");
      }
      const plan = planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: "2026.9.4",
        upgradeSurvivorScenarios: "legacy-operator-state",
        upgradeSurvivorTargetRoot: root,
        allowFrozenTargetScenarioOmissions: false,
        ...(mode === "committed" ? { frozenTarget: { mode: "inert" as const, source } } : {}),
      });
      expect(plan.lanes.map((lane) => lane.name)).toEqual([
        "published-upgrade-survivor-2026.9.4-legacy-operator-state",
      ]);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.each([
    ["wrong root", "[]"],
    ["non-array list", '{"scenarios":["base"],"assertionOnlyScenarios":{}}'],
    ["duplicate entry", '{"scenarios":["base","base"],"assertionOnlyScenarios":[]}'],
  ])("rejects unsupported catalog data: %s", (_shape, content) => {
    const root = tempDirs.make("openclaw-unsupported-inert-catalog-");
    const { catalogFile } = copyCurrentScenarioMetadata(root);
    writeFileSync(catalogFile, content);
    const { sha } = commitTarget(root);
    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: "2026.9.4",
        upgradeSurvivorScenarios: "base",
        upgradeSurvivorTargetRoot: root,
        frozenTarget: { mode: "inert", source: createFrozenTargetSource(root, sha) },
      }),
    ).toThrow(/inert scenario catalog/);
  });

  it("keeps admission inert even when frozen omissions authorize executable legacy planning", () => {
    const root = tempDirs.make("openclaw-inert-catalog-");
    const marker = join(root, "executed");
    const assertions = writeFrozenScenarioContract(root, ["base"]);
    writeFileSync(
      assertions,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n` +
        readFileSync(assertions, "utf8"),
    );
    const { sha } = commitTarget(root);
    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: "2026.6.11",
        upgradeSurvivorTargetRoot: root,
        frozenTarget: { mode: "inert", source: createFrozenTargetSource(root, sha) },
      }),
    ).toThrow(/inert scenario catalog/);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["dirty absent owner", "missing blob"])(
    "uses committed selected metadata for %s",
    (shape) => {
      const root = tempDirs.make("openclaw-inert-metadata-");
      const relative = "src/cli/update-cli/update-command-plugin-preflight.ts";
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      if (shape !== "dirty absent owner") {
        writeFileSync(join(root, relative), "throw new Error('never execute');\n");
      }
      const { sha, git } = commitTarget(root);
      if (shape === "dirty absent owner") {
        writeFileSync(
          join(root, relative),
          "local modification must not imply committed support\n",
        );
      } else {
        const oid = git("rev-parse", `${sha}:${relative}`);
        rmSync(join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      }
      const selected = "update-corrupt-plugin";
      const run = () =>
        planFor({
          selectedLaneNames: [selected],
          upgradeSurvivorTargetRoot: root,
          frozenTarget: { mode: "inert", source: createFrozenTargetSource(root, sha) },
        });
      if (shape === "missing blob") {
        expect(run).toThrow(/unable to read selected source/);
      } else {
        expect(run().omittedUnsupportedLanes).toEqual([selected]);
      }
    },
  );

  const literalFirstHopPostbuild = String.raw`const LEGACY_CLI_EXIT_COMPAT_CHUNKS = [
  // v2026.8.2 and the exact d413210 build load these after replacing dist/.
  // Remove only after both source artifacts fall outside the supported upgrade window.
  {
    dest: "dist/shared-Y6bNiw2w.js",
    contents: LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK,
  },
  {
    dest: "dist/shared-DTaQo6Hi.js",
    contents: LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK,
  },
  {
    dest: "dist/memory-state-CcqRgDZU.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
  {
    dest: "dist/memory-state-DwGdReW4.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
];`;

  it("omits only the first-hop sources a target's own inventory does not record", () => {
    const targetRoot = tempDirs.make("openclaw-partial-first-hop-target-");
    mkdirSync(join(targetRoot, "scripts/lib"), { recursive: true });
    writeFileSync(
      join(targetRoot, "scripts/runtime-postbuild.mts"),
      readFileSync("scripts/runtime-postbuild.mts", "utf8"),
    );
    const [oldest, ...newer] = firstHopSourceVersions;
    writeFileSync(
      join(targetRoot, "scripts/lib/update-compat-inventory.json"),
      JSON.stringify({ schemaVersion: 1, releases: [{ version: oldest }] }),
    );
    const plan = planFor({
      selectedLaneNames: parseLaneSelection("update-first-hop-compat"),
      upgradeSurvivorTargetRoot: targetRoot,
    });
    expect(plan.lanes.map((lane) => lane.name)).toEqual([updateFirstHopCompatLaneName(oldest)]);
    expect(plan.lanes[0]?.timeoutMs).toBe(3_500_000);
    expect(plan.omittedUnsupportedLanes).toEqual([
      ...newer.map(updateFirstHopCompatLaneName),
      UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
    ]);
  });

  it("keeps source hops and gates post-convergence proof on candidate admission", () => {
    for (const version of firstHopSourceVersions) {
      expect(findLaneByName(updateFirstHopCompatLaneName(version))?.command).toBe(
        `OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 OPENCLAW_UPDATE_FIRST_HOP_SCENARIO=source OPENCLAW_UPDATE_FIRST_HOP_SOURCE_VERSIONS=${version} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-first-hop-compat`,
      );
    }
    const targetRoot = tempDirs.make("openclaw-first-hop-admission-target-");
    writeFileSync(
      join(targetRoot, "package.json"),
      JSON.stringify({ openclaw: { updateAdmissionProtocol: 1 } }),
    );
    const plan = planFor({
      selectedLaneNames: [UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE],
      upgradeSurvivorTargetRoot: targetRoot,
    });
    expect(plan.lanes.map(summarizeLane)).toEqual([
      {
        command:
          "OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 OPENCLAW_UPDATE_FIRST_HOP_SCENARIO=missing-load-path OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-first-hop-compat",
        imageKind: "bare",
        live: false,
        name: UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
        resources: ["docker", "npm", "service"],
        stateScenario: "upgrade-survivor",
        timeoutMs: 3_500_000,
        weight: 2,
      },
    ]);
    expect(plan.omittedUnsupportedLanes).toEqual([]);

    writeFileSync(
      join(targetRoot, "package.json"),
      JSON.stringify({ openclaw: { updateAdmissionProtocol: 2 } }),
    );
    const unsupported = planFor({
      selectedLaneNames: [UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE],
      upgradeSurvivorTargetRoot: targetRoot,
    });
    expect(unsupported.lanes).toEqual([]);
    expect(unsupported.omittedUnsupportedLanes).toEqual([UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE]);
  });

  it.each([
    ["unrelated", ""],
    ["absent", ""],
  ])(
    "does not infer first-hop support from %s with missing or unrelated outputs %s",
    (shape, missing) => {
      const targetRoot = tempDirs.make("openclaw-missing-first-hop-target-");
      mkdirSync(join(targetRoot, "scripts"));
      if (shape !== "absent") {
        const source = literalFirstHopPostbuild;
        writeFileSync(
          join(targetRoot, "scripts/runtime-postbuild.mts"),
          shape === "unrelated"
            ? source.replace("const LEGACY_CLI_EXIT_COMPAT_CHUNKS", "const UNRELATED_OUTPUTS")
            : source.replaceAll(missing, "missing.js"),
        );
      }
      const plan = planFor({
        selectedLaneNames: parseLaneSelection("update-first-hop-compat"),
        upgradeSurvivorTargetRoot: targetRoot,
      });
      expect(plan.lanes).toEqual([]);
      expect(plan.omittedUnsupportedLanes).toEqual(firstHopLaneNames);
    },
  );

  it("omits corrupt-plugin update admission only for authorized targets without the owner", () => {
    const targetRoot = tempDirs.make("openclaw-corrupt-update-target-");
    const unsupported = planFor({
      selectedLaneNames: ["update-corrupt-plugin"],
      upgradeSurvivorTargetRoot: targetRoot,
    });
    expect(unsupported.lanes).toEqual([]);
    expect(unsupported.omittedUnsupportedLanes).toEqual(["update-corrupt-plugin"]);

    const unauthorized = planFor({
      allowFrozenTargetScenarioOmissions: false,
      selectedLaneNames: ["update-corrupt-plugin"],
      upgradeSurvivorTargetRoot: targetRoot,
    });
    expect(unauthorized.lanes.map((lane) => lane.name)).toEqual(["update-corrupt-plugin"]);

    const preflight = join(targetRoot, "src/cli/update-cli/update-command-plugin-preflight.ts");
    mkdirSync(dirname(preflight), { recursive: true });
    writeFileSync(preflight, "export {};\n");
    const supported = planFor({
      selectedLaneNames: ["update-corrupt-plugin"],
      upgradeSurvivorTargetRoot: targetRoot,
    });
    expect(supported.lanes.map((lane) => lane.name)).toEqual(["update-corrupt-plugin"]);
  });

  it("routes trusted Docker scripts through the nested release harness", () => {
    const trustedScripts = new Map([
      ["live-codex-npm-plugin", "e2e/codex-npm-plugin-live-docker.sh"],
      ["upgrade-survivor", "e2e/upgrade-survivor-docker.sh"],
      ["published-upgrade-survivor", "e2e/upgrade-survivor-docker.sh"],
      ["dreaming-cron-doctor", "e2e/upgrade-survivor-docker.sh"],
      ["root-managed-vps-upgrade", "e2e/upgrade-survivor-docker.sh"],
      ["update-migration", "e2e/upgrade-survivor-docker.sh"],
    ]);
    const tempRoot = tempDirs.make("openclaw-release-harness-");
    const nestedModule = join(
      tempRoot,
      ".release-harness",
      "scripts",
      "lib",
      "docker-e2e-scenarios.mts",
    );

    mkdirSync(dirname(nestedModule), { recursive: true });
    for (const fileName of [
      "docker-e2e-scenarios.mts",
      "update-compat-inventory.json",
      "update-first-hop-lanes.mjs",
    ]) {
      copyFileSync(join("scripts/lib", fileName), join(dirname(nestedModule), fileName));
    }

    const laneJson = execFileSync(
      testNodeExecPath,
      [
        "--input-type=module",
        "--eval",
        `
            import { pathToFileURL } from "node:url";
            const scenarios = await import(pathToFileURL(process.argv[1]).href);
            const names = ${JSON.stringify([...trustedScripts.keys()])};
            const lanes = [
              ...new Map(
                [
                  ...scenarios.allReleasePathLanes({ releaseProfile: "beta" }),
                  ...scenarios.mainLanes,
                ]
                  .filter((candidate) => names.includes(candidate.name))
                  .map((candidate) => [candidate.name, candidate]),
              ).values(),
            ];
            process.stdout.write(JSON.stringify(lanes));
          `,
        nestedModule,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: tempRoot,
        },
      },
    );
    const lanes = JSON.parse(laneJson) as Array<{ command: string; name: string }>;

    expect(lanes).toHaveLength(trustedScripts.size);
    for (const lane of lanes) {
      expect(lane.command).toContain(
        'harness="${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-.release-harness}"',
      );
      expect(lane.command).toContain(`bash "$harness/scripts/${trustedScripts.get(lane.name)}"`);
      expect(lane.command).not.toContain(`pnpm test:docker:${lane.name}`);
    }
  });

  it.each([
    { name: "published-upgrade-survivor", baseline: "2026.7.2", scenario: "feishu-channel" },
  ])(
    "passes the $name baseline through the trusted harness wrapper ($baseline)",
    ({ name, baseline, scenario }) => {
      const root = tempDirs.make("openclaw-survivor-wrapper-");
      const harnessRoot = join(root, ".release-harness");
      const script = join(harnessRoot, "scripts/e2e/upgrade-survivor-docker.sh");
      const output = join(root, "survivor-env.txt");
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          'printf "%s|%s\\n" "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC" "$OPENCLAW_UPGRADE_SURVIVOR_SCENARIO" > "$OPENCLAW_TEST_OUTPUT"',
        ].join("\n"),
      );
      chmodSync(script, 0o755);

      const lane = requireFirstLane(
        planFor({
          selectedLaneNames: [name],
          upgradeSurvivorBaselines: baseline,
          upgradeSurvivorScenarios: scenario,
        }),
      );
      execFileSync("/bin/bash", ["-c", lane.command], {
        cwd: root,
        env: {
          ...process.env,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: root,
          OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR: harnessRoot,
          OPENCLAW_TEST_OUTPUT: output,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
        },
      });

      expect(readFileSync(output, "utf8")).toBe(`openclaw@${baseline ?? "latest"}|${scenario}\n`);
    },
  );

  it("includes deterministic packaged MCP code-mode proof in the unfiltered release core", () => {
    const plan = planFor({
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "core",
    });
    const codeModeLanes = plan.lanes.filter((lane) => lane.name === "mcp-code-mode-gateway");

    expect(plan.selectedLanes).toEqual([]);
    expect(codeModeLanes.map(summarizeLane)).toEqual([
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-code-mode-gateway",
        imageKind: "functional",
        live: false,
        name: "mcp-code-mode-gateway",
        resources: ["docker", "service", "npm"],
        stateScenario: "empty",
        weight: 3,
      },
    ]);
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("live-mcp-code-mode-gateway");
  });

  it("partitions minimum package/update core without losing or duplicating proof", () => {
    const options = { profile: RELEASE_PATH_PROFILE, releaseProfile: "minimum" as const };
    const aggregate = planFor({ ...options, releaseChunk: "package-update-core" });
    const partitions = [
      "package-update-onboarding",
      "package-update-migrations",
      "package-update-self-upgrade",
    ].map((releaseChunk) => planFor({ ...options, releaseChunk }));
    const lanes = partitions.flatMap((partition) => partition.lanes);

    expect(partitions.map((partition) => partition.lanes.length)).toEqual([
      5,
      2,
      1 + firstHopLaneNames.length,
    ]);
    expect(new Set(lanes.map((lane) => lane.name)).size).toBe(8 + firstHopLaneNames.length);
    expect(lanes.map(summarizeLane)).toEqual(aggregate.lanes.map(summarizeLane));
    const complete = planFor({ ...options, planReleaseAll: true });
    const packageNames = new Set(lanes.map((lane) => lane.name));
    expect(complete.lanes.filter((lane) => packageNames.has(lane.name))).toEqual(lanes);
  });

  it("keeps restart auth exactly once in the legacy package/update aggregate", () => {
    const aggregate = planFor({
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "package-update",
    });

    expect(aggregate.lanes.filter((lane) => lane.name === "update-restart-auth")).toHaveLength(1);
  });

  it("includes OpenWebUI exactly once in each legacy plugin aggregate", () => {
    for (const releaseChunk of [
      "plugins-runtime-core",
      "plugins-runtime",
      "plugins-integrations",
    ]) {
      const withOpenWebUI = planFor({
        includeOpenWebUI: true,
        profile: RELEASE_PATH_PROFILE,
        releaseChunk,
      });
      const withoutOpenWebUI = planFor({
        includeOpenWebUI: false,
        profile: RELEASE_PATH_PROFILE,
        releaseChunk,
      });

      expect(
        withOpenWebUI.lanes.filter((lane) => lane.name === "openwebui"),
        releaseChunk,
      ).toHaveLength(1);
      expect(
        withoutOpenWebUI.lanes.map((lane) => lane.name),
        releaseChunk,
      ).not.toContain("openwebui");
    }
  });

  it("keeps strict released readers in stable recovery coverage after latest advances", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "openclaw@2026.9.12",
      upgradeSurvivorScenarios: "reported-issues",
      upgradeSurvivorTargetRoot: ".",
    });
    const recovery = plan.lanes.filter((lane) =>
      /package-(?:publication-recovery|verification-recovery|stranded-first-hop)/u.test(lane.name),
    );
    expect(recovery.map((lane) => lane.name).toSorted()).toEqual([
      "published-upgrade-survivor-2026.9.7-package-stranded-first-hop",
      "published-upgrade-survivor-2026.9.8-package-publication-recovery",
      "published-upgrade-survivor-2026.9.8-package-verification-recovery",
      "published-upgrade-survivor-2026.9.9-package-publication-recovery",
      "published-upgrade-survivor-2026.9.9-package-verification-recovery",
    ]);
    for (const lane of recovery) {
      expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=");
      expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=");
    }
  });

  it("rejects pre-June baselines before scheduling against the target", () => {
    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor", "update-migration"],
        upgradeSurvivorBaselines: "2026.6.1 openclaw@2026.5.35",
        upgradeSurvivorTargetRoot: ".",
      }),
    ).toThrow("must be 2026.6.1 or newer");
  });

  it.each([
    { baseline: "2026.9.4", scenario: "abandoned-update" },
    { baseline: "2026.7.1-2", scenario: "prerelease-plugin-registry" },
    { baseline: "2026.7.1-2", scenario: "recovery-cleanup" },
  ])("plans $scenario only when explicitly requested", ({ baseline, scenario }) => {
    const laneName = `published-upgrade-survivor-${baseline}-${scenario}`;
    const explicitPlan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: baseline,
      upgradeSurvivorScenarios: scenario,
    });

    expect(explicitPlan.lanes.map(summarizeLane)).toEqual([
      publishedUpgradeSurvivorLane(laneName, `openclaw@${baseline}`, scenario),
    ]);
    if (scenario === "abandoned-update") {
      expect(explicitPlan.requiredPrepublishPluginPackages).toEqual([]);
    }
    if (scenario === "recovery-cleanup") {
      expect(explicitPlan.requiredPrepublishPluginPackages).toEqual([
        "@openclaw/codex",
        "@openclaw/discord",
        "@openclaw/whatsapp",
      ]);
    }

    for (const aggregateScenario of ["reported-issues", "far-reaching"]) {
      const aggregateLaneNames = planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: baseline,
        upgradeSurvivorScenarios: aggregateScenario,
      }).lanes.map((lane) => lane.name);

      expect(aggregateLaneNames).not.toContain(laneName);
    }
  });

  it.each([
    ["workshop-doctor-recovery", "2026.9.4", "2026.9.3 2026.9.4 2026.9.5"],
    ["update-report-recovery", "2026.9.6", "2026.9.5 2026.9.6 2026.9.7"],
  ])("pins opt-in %s to published %s without credentials", (scenario, baseline, baselines) => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: baselines,
      upgradeSurvivorScenarios: scenario,
    });
    const name = `published-upgrade-survivor-${baseline}-${scenario}`;
    expect(plan.lanes.map(summarizeLane)).toEqual([
      publishedUpgradeSurvivorLane(name, `openclaw@${baseline}`, scenario),
    ]);
    expect(plan.requiredPrepublishPluginPackages).toEqual([]);
    expect(plan.credentials).toEqual([]);
    for (const alias of ["reported-issues", "far-reaching"]) {
      expect(
        planFor({
          selectedLaneNames: ["published-upgrade-survivor"],
          upgradeSurvivorBaselines: baseline,
          upgradeSurvivorScenarios: alias,
        }).lanes.map((lane) => lane.name),
      ).not.toContain(name);
    }
  });

  it.each([
    { scenario: "projects-startup-migration", baselines: ["2026.9.4"] },
    { scenario: "dreaming-cron-doctor", baselines: ["2026.9.6"] },
    { scenario: "cron-owner-doctor", baselines: ["2026.9.4", "2026.9.7"] },
  ])(
    "plans $scenario only for its exact supported published writers without registry or credential fixtures",
    ({ scenario, baselines }) => {
      const plan = planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: "2026.9.3 2026.9.4 2026.9.5 2026.9.6 2026.9.7 latest",
        upgradeSurvivorScenarios: scenario,
      });
      const expected = baselines.map((baseline) =>
        publishedUpgradeSurvivorLane(
          `published-upgrade-survivor-${baseline}-${scenario}`,
          `openclaw@${baseline}`,
          scenario,
        ),
      );
      expect(plan.lanes.map(summarizeLane)).toEqual(expected);
      expect(plan.requiredPrepublishPluginPackages).toEqual([]);
      expect(plan.credentials).toEqual([]);
      for (const alias of ["reported-issues", "far-reaching"]) {
        const aliasNames = planFor({
          selectedLaneNames: ["published-upgrade-survivor"],
          upgradeSurvivorBaselines: baselines.join(" "),
          upgradeSurvivorScenarios: alias,
        }).lanes.map((lane) => lane.name);
        for (const lane of expected) {
          expect(aliasNames).not.toContain(lane.name);
        }
      }
    },
  );

  it("reads content-addressed scenario catalogs from pre-command frozen targets", () => {
    const targetRoot = tempDirs.make("openclaw-legacy-frozen-upgrade-harness-");
    const assertionsFile = join(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
    const legacyScenarios = [
      "base",
      "feishu-channel",
      "bootstrap-persona",
      "channel-post-core-restore",
      "plugin-deps-cleanup",
      "configured-plugin-installs",
      "stale-source-plugin-shadow",
      "tilde-log-path",
      "versioned-runtime-deps",
    ];
    mkdirSync(dirname(assertionsFile), { recursive: true });
    writeFileSync(
      assertionsFile,
      [
        "const SCENARIOS = new Set([",
        ...legacyScenarios.map((scenario) => `  "${scenario}",`),
        "]);",
        'throw new Error("unknown upgrade-survivor assertion command: list-scenarios");',
      ].join("\n"),
    );

    const { sha } = commitTarget(targetRoot);
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "2026.6.11",
      upgradeSurvivorScenarios: "reported-issues",
      upgradeSurvivorTargetRoot: targetRoot,
      frozenTarget: { mode: "inert", source: createFrozenTargetSource(targetRoot, sha) },
    });

    expect(plan.omittedUnsupportedLanes).toEqual([
      "published-upgrade-survivor-2026.6.11-acpx-openclaw-tools-bridge",
      "published-upgrade-survivor-2026.6.11-meeting-transcripts-sqlite",
      "published-upgrade-survivor-2026.6.11-cron-scheduled-authority",
      "published-upgrade-survivor-2026.9.8-package-publication-recovery",
      "published-upgrade-survivor-2026.9.9-package-publication-recovery",
      "published-upgrade-survivor-2026.9.8-package-verification-recovery",
      "published-upgrade-survivor-2026.9.9-package-verification-recovery",
      "published-upgrade-survivor-2026.9.7-package-stranded-first-hop",
    ]);
    const catalogFile = join(targetRoot, "scripts/lib/upgrade-survivor-scenarios.json");
    mkdirSync(dirname(catalogFile), { recursive: true });
    writeFileSync(catalogFile, "invalid current catalog");
    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorBaselines: "2026.6.11",
        upgradeSurvivorScenarios: "base",
        upgradeSurvivorTargetRoot: targetRoot,
        allowFrozenTargetScenarioOmissions: false,
      }),
    ).toThrow(/unrecognized scenario contract/);
  });

  it("recognizes the frozen combined mobile and watch scenario catalog", () => {
    const targetRoot = tempDirs.make("openclaw-platform-survivors-frozen-harness-");
    const assertionsFile = join(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
    const scenarios = [
      "base",
      "mobile-pairing-reconnect",
      "acpx-openclaw-tools-bridge",
      "feishu-channel",
      "bootstrap-persona",
      "channel-post-core-restore",
      "codex-allowlist-survival",
      "plugin-deps-cleanup",
      "configured-plugin-installs",
      "stale-source-plugin-shadow",
      "prerelease-plugin-registry",
      "tilde-log-path",
      "meeting-transcripts-sqlite",
      "versioned-runtime-deps",
      "cron-scheduled-authority",
      "sqlite-volume",
      "recovery-cleanup",
      "auth-profile-v2026-7-2-beta-5",
      "watchos-direct-node",
    ];
    mkdirSync(dirname(assertionsFile), { recursive: true });
    writeFileSync(
      assertionsFile,
      [
        "const SCENARIOS = new Set([",
        ...scenarios.map((scenario) => `  "${scenario}",`),
        "]);",
        'throw new Error("unknown upgrade-survivor assertion command: list-scenarios");',
      ].join("\n"),
    );

    const plan = planFor({
      selectedLaneNames: ["update-migration"],
      upgradeSurvivorBaselines: "2026.7.1 2026.8.1",
      upgradeSurvivorScenarios: "mobile-pairing-reconnect watchos-direct-node",
      upgradeSurvivorTargetRoot: targetRoot,
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "update-migration-2026.8.1-watchos-direct-node",
    ]);
    expect(plan.omittedUnsupportedLanes).toEqual([
      "update-migration-2026.7.1-mobile-pairing-reconnect",
      "update-migration-2026.8.1-mobile-pairing-reconnect",
    ]);
  });

  it("keeps mobile pairing when an unapproved target lacks a source-qualified omission", () => {
    const targetRoot = tempDirs.make("openclaw-frozen-mobile-package-target-");
    writeFrozenScenarioContract(targetRoot, ["base"]);

    const plan = planFor({
      selectedLaneNames: ["update-migration"],
      upgradeSurvivorBaselines: "2026.7.1",
      upgradeSurvivorScenarios: "mobile-pairing-reconnect",
      upgradeSurvivorTargetRoot: targetRoot,
      allowFrozenTargetScenarioOmissions: false,
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "update-migration-2026.7.1-mobile-pairing-reconnect",
    ]);
    expect(plan.omittedUnsupportedLanes).toEqual([]);
  });

  it("keeps mobile pairing when the selected Gateway admits iPhone watch relay", () => {
    const targetRoot = tempDirs.make("openclaw-frozen-mobile-watch-relay-");
    writeFrozenScenarioContract(targetRoot, ["base"]);
    const policy = join(targetRoot, "src/gateway/node-command-policy.ts");
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(
      policy,
      'const commands = ["watch.status", "watch.notify"];\nplatformId === "ios";\nnormalizeDeviceMetadataForPolicy(node?.deviceFamily) === "iphone";\nnew Set([...watchRelayCommands]);\n',
    );

    const plan = planFor({
      selectedLaneNames: ["update-migration"],
      upgradeSurvivorBaselines: "2026.7.1",
      upgradeSurvivorScenarios: "mobile-pairing-reconnect",
      upgradeSurvivorTargetRoot: targetRoot,
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "update-migration-2026.7.1-mobile-pairing-reconnect",
    ]);
  });

  it("reports an explicitly selected expanded survivor lane as unsupported", () => {
    const targetRoot = tempDirs.make("openclaw-frozen-expanded-upgrade-harness-");
    writeFrozenScenarioContract(targetRoot, ["unrelated"]);

    const selectedLane = "published-upgrade-survivor-2026.6.11";
    const plan = planFor({
      selectedLaneNames: [selectedLane],
      upgradeSurvivorBaselines: "2026.6.11",
      upgradeSurvivorTargetRoot: targetRoot,
    });

    expect(plan.lanes).toEqual([]);
    expect(plan.omittedUnsupportedLanes).toEqual([selectedLane]);
  });

  it("fails closed when an unknown legacy scenario catalog lacks the command", () => {
    const targetRoot = tempDirs.make("openclaw-frozen-failed-scenario-harness-");
    const assertionsFile = join(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
    mkdirSync(dirname(assertionsFile), { recursive: true });
    writeFileSync(
      assertionsFile,
      [
        'const SCENARIOS = new Set(["base"]);',
        'throw new Error("unknown upgrade-survivor assertion command: list-scenarios");',
      ].join("\n"),
    );

    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorScenarios: "reported-issues",
        upgradeSurvivorTargetRoot: targetRoot,
      }),
    ).toThrow("unknown upgrade-survivor assertion command: list-scenarios");
  });

  it("fails closed when a frozen target scenario command returns non-JSON output", () => {
    const targetRoot = tempDirs.make("openclaw-frozen-non-json-scenario-harness-");
    const assertionsFile = join(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
    mkdirSync(dirname(assertionsFile), { recursive: true });
    writeFileSync(assertionsFile, 'process.stdout.write("base");\n');

    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorScenarios: "reported-issues",
        upgradeSurvivorTargetRoot: targetRoot,
      }),
    ).toThrow("list-scenarios did not return JSON");
  });

  it("fails closed when a frozen target scenario command returns an invalid catalog", () => {
    const targetRoot = tempDirs.make("openclaw-frozen-invalid-scenario-harness-");
    const assertionsFile = join(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
    mkdirSync(dirname(assertionsFile), { recursive: true });
    writeFileSync(assertionsFile, 'process.stdout.write("[\\"base\\",\\"base\\"]");\n');

    expect(() =>
      planFor({
        selectedLaneNames: ["published-upgrade-survivor"],
        upgradeSurvivorScenarios: "reported-issues",
        upgradeSurvivorTargetRoot: targetRoot,
      }),
    ).toThrow("list-scenarios returned an invalid catalog");
  });

  it("excludes Open WebUI from skip-live Docker all plans", () => {
    const plan = planFor({
      liveMode: "skip",
    });

    expect(plan.lanes.map((lane) => lane.name)).not.toContain("openwebui");
  });

  it("maps installer E2E to provider-specific package install lanes", () => {
    const selectedLaneNames = parseLaneSelection("install-e2e");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(["install-e2e-openai", "install-e2e-anthropic"]);
    expect(
      plan.lanes.map((lane) => ({
        imageKind: lane.imageKind,
        live: lane.live,
        name: lane.name,
        resources: lane.resources,
        timeoutMs: lane.timeoutMs,
        weight: lane.weight,
      })),
    ).toEqual([
      {
        imageKind: "bare",
        live: true,
        name: "install-e2e-openai",
        resources: ["docker", "live", "live:openai", "npm", "service"],
        timeoutMs: 900_000,
        weight: 3,
      },
      {
        imageKind: "bare",
        live: true,
        name: "install-e2e-anthropic",
        resources: ["docker", "live", "live:claude", "npm", "service"],
        weight: 3,
      },
    ]);
    expect(plan.credentials).toEqual(["anthropic", "openai"]);
  });

  it("rejects unknown selected lanes with the available lane names", () => {
    expect(() => planFor({ selectedLaneNames: ["missing-lane"] })).toThrow(
      /OPENCLAW_DOCKER_ALL_LANES unknown lane\(s\): missing-lane/u,
    );
  });
});
