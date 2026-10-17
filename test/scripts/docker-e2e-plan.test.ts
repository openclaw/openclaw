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
type PlanOptions = Partial<Parameters<typeof resolveDockerE2ePlan>[0]>;
type Plan = ReturnType<typeof resolveDockerE2ePlan>["plan"];

function writeTargetFile(root: string, relative: string, contents: string) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function writeFrozenScenarioContract(targetRoot: string, scenarios: string[]): string {
  return writeTargetFile(
    targetRoot,
    "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
    [
      `const scenarios = ${JSON.stringify(scenarios)};`,
      'if (process.argv[2] !== "list-scenarios") throw new Error("unknown command");',
      "process.stdout.write(`${JSON.stringify(scenarios)}\\n`);",
    ].join("\n"),
  );
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
const laneNames = (plan: Plan) => plan.lanes.map((lane) => lane.name);

function planFor(overrides: PlanOptions = {}): Plan {
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

function survivorPlan(
  root: string | undefined,
  baselines: string,
  scenarios?: string,
  overrides: PlanOptions = {},
) {
  return selectedPlan(root, "published-upgrade-survivor", {
    upgradeSurvivorBaselines: baselines,
    ...(scenarios ? { upgradeSurvivorScenarios: scenarios } : {}),
    ...overrides,
  });
}

function selectedPlan(root: string | undefined, selected: string, overrides: PlanOptions = {}) {
  return planFor({
    selectedLaneNames: parseLaneSelection(selected),
    upgradeSurvivorTargetRoot: root,
    ...overrides,
  });
}

function expectPlanLanes(plan: Plan, names: string[], omitted?: string[]) {
  expect(laneNames(plan)).toEqual(names);
  if (omitted) {
    expect(plan.omittedUnsupportedLanes).toEqual(omitted);
  }
}

function writeLegacyScenarioContract(root: string, scenarios: string[]) {
  return writeTargetFile(
    root,
    "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
    [
      "const SCENARIOS = new Set([",
      ...scenarios.map((scenario) => `  "${scenario}",`),
      "]);",
      'throw new Error("unknown upgrade-survivor assertion command: list-scenarios");',
    ].join("\n"),
  );
}

function requireFirstLane(plan: Plan) {
  const [lane] = plan.lanes;
  if (!lane) {
    throw new Error("Expected at least one Docker E2E lane");
  }
  return lane;
}

function summarizeLane(lane: Plan["lanes"][number]) {
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

const trustedUpgradeSurvivorCommand = `OPENCLAW_DOCKER_E2E_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT=1500s OPENCLAW_SKIP_DOCKER_BUILD=1 bash -c 'export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="\${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-openclaw@latest}"; export OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT="\${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-2280s}"; harness="\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-.}"; OPENCLAW_LIVE_DOCKER_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" bash "$harness/scripts/e2e/upgrade-survivor-docker.sh"'`;

function publishedUpgradeSurvivorLane(
  name: string,
  baselineSpec: string,
  scenario: string,
): ReturnType<typeof summarizeLane> {
  return {
    command: `OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/${name}" OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='${baselineSpec}' OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='${scenario}' ${trustedUpgradeSurvivorCommand}`,
    imageKind: "bare",
    live: false,
    name,
    resources: ["docker", "npm"],
    stateScenario: "upgrade-survivor",
    timeoutMs: 2_580_000,
    weight: 3,
  };
}

function expectOptInScenario(
  baselines: string,
  scenario: string,
  supported = baselines.split(" "),
) {
  const options = {
    selectedLaneNames: ["published-upgrade-survivor"],
    upgradeSurvivorBaselines: baselines,
  };
  const plan = planFor({ ...options, upgradeSurvivorScenarios: scenario });
  const expected = supported.map((baseline) =>
    publishedUpgradeSurvivorLane(
      `published-upgrade-survivor-${baseline}-${scenario}`,
      `openclaw@${baseline}`,
      scenario,
    ),
  );
  expect(plan.lanes.map(summarizeLane)).toEqual(expected);
  for (const alias of ["reported-issues", "far-reaching"]) {
    const names = planFor({
      ...options,
      upgradeSurvivorBaselines: supported.join(" "),
      upgradeSurvivorScenarios: alias,
    }).lanes.map((lane) => lane.name);
    for (const lane of expected) {
      expect(names).not.toContain(lane.name);
    }
  }
  return plan;
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

  function targetFixture(scenarios?: string[]) {
    const root = tempDirs.make("openclaw-plan-");
    if (scenarios) {
      writeFrozenScenarioContract(root, scenarios);
    }
    return {
      root,
      write: (relative: string, contents: string) => writeTargetFile(root, relative, contents),
      plan: (selected: string, options: PlanOptions = {}) => selectedPlan(root, selected, options),
      survivor: (baseline: string, scenario?: string, options: PlanOptions = {}) =>
        survivorPlan(root, baseline, scenario, options),
      freeze: () => ({
        mode: "inert" as const,
        source: createFrozenTargetSource(root, commitTarget(root).sha),
      }),
    };
  }

  it("admits the current frozen catalog for missing-configured-plugin-migration", () => {
    const { root, survivor, freeze } = targetFixture();
    copyCurrentScenarioMetadata(root);
    copyFileSync("package.json", join(root, "package.json"));
    expectPlanLanes(
      survivor("2026.9.2", "missing-configured-plugin-migration", {
        frozenTarget: freeze(),
      }),
      ["published-upgrade-survivor-2026.9.2-missing-configured-plugin-migration"],
      [],
    );
  });

  it("rejects execution of the retired Teams JSON migration scenario", () => {
    expect(() => survivorPlan(undefined, "2026.9.5", "msteams-polls")).toThrow(
      "invalid published upgrade survivor scenario",
    );
  });

  it.each(["committed", "unapproved checkout"])(
    "reads declared JSON capabilities without executing its %s modules",
    (mode) => {
      const { root, survivor, freeze } = targetFixture();
      const { assertionsFile, policyFile, catalogFile } = copyCurrentScenarioMetadata(root);
      const marker = join(root, "executed");
      const markerCode = `\nimport { writeFileSync as markExecuted } from "node:fs"; markExecuted(${JSON.stringify(marker)}, "executed");\n`;
      for (const file of [assertionsFile, policyFile]) {
        writeFileSync(file, readFileSync(file, "utf8") + markerCode);
      }
      const frozenTarget = freeze();
      if (mode === "committed") {
        writeFileSync(catalogFile, "uncommitted catalog must not be read\n");
      }
      expectPlanLanes(
        survivor("2026.9.4", "legacy-operator-state", {
          allowFrozenTargetScenarioOmissions: false,
          ...(mode === "committed" ? { frozenTarget } : {}),
        }),
        ["published-upgrade-survivor-2026.9.4-legacy-operator-state"],
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.each([
    ["wrong root", "[]"],
    ["non-array list", '{"scenarios":["base"],"assertionOnlyScenarios":{}}'],
    ["duplicate entry", '{"scenarios":["base","base"],"assertionOnlyScenarios":[]}'],
  ])("rejects unsupported catalog data: %s", (_shape, content) => {
    const { root, survivor, freeze } = targetFixture();
    const { catalogFile } = copyCurrentScenarioMetadata(root);
    writeFileSync(catalogFile, content);
    const frozenTarget = freeze();
    expect(() => survivor("2026.9.4", "base", { frozenTarget })).toThrow(/inert scenario catalog/);
  });

  it("keeps admission inert even when frozen omissions authorize executable legacy planning", () => {
    const { root, survivor, freeze } = targetFixture();
    const marker = join(root, "executed");
    const assertions = writeFrozenScenarioContract(root, ["base"]);
    writeFileSync(
      assertions,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n` +
        readFileSync(assertions, "utf8"),
    );
    const frozenTarget = freeze();
    expect(() => survivor("2026.6.11", undefined, { frozenTarget })).toThrow(
      /inert scenario catalog/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["dirty absent owner", "missing blob"])(
    "uses committed selected metadata for %s",
    (shape) => {
      const { root, write, plan } = targetFixture();
      const relative = "src/cli/update-cli/update-command-plugin-preflight.ts";
      write("package.json", "{}");
      if (shape !== "dirty absent owner") {
        write(relative, "throw new Error('never execute');\n");
      }
      const { sha, git } = commitTarget(root);
      if (shape === "dirty absent owner") {
        write(relative, "local modification must not imply committed support\n");
      } else {
        const oid = git("rev-parse", `${sha}:${relative}`);
        rmSync(join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      }
      const selected = "update-corrupt-plugin";
      const run = () =>
        plan(selected, {
          frozenTarget: { mode: "inert", source: createFrozenTargetSource(root, sha) },
        });
      if (shape === "missing blob") {
        expect(run).toThrow(/unable to read selected source/);
      } else {
        expect(run().omittedUnsupportedLanes).toEqual([selected]);
      }
    },
  );

  it("omits only the first-hop sources a target's own inventory does not record", () => {
    const { write, plan: selected } = targetFixture();
    write("scripts/runtime-postbuild.mts", readFileSync("scripts/runtime-postbuild.mts", "utf8"));
    const [oldest, ...newer] = firstHopSourceVersions;
    write(
      "scripts/lib/update-compat-inventory.json",
      JSON.stringify({ schemaVersion: 1, releases: [{ version: oldest }] }),
    );
    const plan = selected("update-first-hop-compat");
    expectPlanLanes(
      plan,
      [updateFirstHopCompatLaneName(oldest)],
      [...newer.map(updateFirstHopCompatLaneName), UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE],
    );
    expect(plan.lanes[0]?.timeoutMs).toBe(3_500_000);
  });

  it("keeps source hops and gates post-convergence proof on candidate admission", () => {
    for (const version of firstHopSourceVersions) {
      expect(findLaneByName(updateFirstHopCompatLaneName(version))?.command).toBe(
        `OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 OPENCLAW_UPDATE_FIRST_HOP_SCENARIO=source OPENCLAW_UPDATE_FIRST_HOP_SOURCE_VERSIONS=${version} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-first-hop-compat`,
      );
    }
    const { write, plan: selected } = targetFixture();
    write("package.json", JSON.stringify({ openclaw: { updateAdmissionProtocol: 1 } }));
    const plan = selected(UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE);
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

    write("package.json", JSON.stringify({ openclaw: { updateAdmissionProtocol: 2 } }));
    expectPlanLanes(
      selected(UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE),
      [],
      [UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE],
    );
  });

  it.each(["unrelated", "absent"])("does not infer first-hop support from %s outputs", (shape) => {
    const { write, plan } = targetFixture();
    if (shape !== "absent") {
      write(
        "scripts/runtime-postbuild.mts",
        String.raw`const UNRELATED_OUTPUTS = [
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
];`,
      );
    }
    expectPlanLanes(plan("update-first-hop-compat"), [], firstHopLaneNames);
  });

  it("omits corrupt-plugin update admission only for authorized targets without the owner", () => {
    const { write, plan } = targetFixture();
    const selected = "update-corrupt-plugin";
    expectPlanLanes(plan(selected), [], [selected]);
    expectPlanLanes(plan(selected, { allowFrozenTargetScenarioOmissions: false }), [selected]);
    write("src/cli/update-cli/update-command-plugin-preflight.ts", "export {};\n");
    expectPlanLanes(plan(selected), [selected]);
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

  it("passes the published-upgrade-survivor baseline through the trusted harness wrapper", () => {
    const baseline = "2026.7.2",
      scenario = "feishu-channel";
    const root = tempDirs.make("openclaw-survivor-wrapper-");
    const harnessRoot = join(root, ".release-harness");
    const output = join(root, "survivor-env.txt");
    const script = writeTargetFile(
      harnessRoot,
      "scripts/e2e/upgrade-survivor-docker.sh",
      '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC" "$OPENCLAW_UPGRADE_SURVIVOR_SCENARIO" > "$OPENCLAW_TEST_OUTPUT"',
    );
    chmodSync(script, 0o755);

    const lane = requireFirstLane(survivorPlan(undefined, baseline, scenario));
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

    expect(readFileSync(output, "utf8")).toBe(`openclaw@${baseline}|${scenario}\n`);
  });

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
    expect(laneNames(plan)).not.toContain("live-mcp-code-mode-gateway");
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
      const withoutOpenWebUI = planFor({ profile: RELEASE_PATH_PROFILE, releaseChunk });

      expect(
        withOpenWebUI.lanes.filter((lane) => lane.name === "openwebui"),
        releaseChunk,
      ).toHaveLength(1);
      expect(laneNames(withoutOpenWebUI), releaseChunk).not.toContain("openwebui");
    }
  });

  it("keeps strict released readers in stable recovery coverage after latest advances", () => {
    const plan = survivorPlan(".", "openclaw@2026.9.12", "reported-issues");
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
    const explicitPlan = expectOptInScenario(baseline, scenario);
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
  });

  it.each([
    ["workshop-doctor-recovery", ["2026.9.4"], "2026.9.3 2026.9.4 2026.9.5"],
    ["update-report-recovery", ["2026.9.6"], "2026.9.5 2026.9.6 2026.9.7"],
    ["projects-startup-migration", ["2026.9.4"]],
    ["dreaming-cron-doctor", ["2026.9.6"]],
    ["cron-owner-doctor", ["2026.9.4", "2026.9.7"]],
  ] as const)(
    "pins opt-in %s to its supported writers without registry or credentials",
    (scenario, baselines, requested) => {
      const plan = expectOptInScenario(
        requested ?? "2026.9.3 2026.9.4 2026.9.5 2026.9.6 2026.9.7 latest",
        scenario,
        [...baselines],
      );
      expect(plan).toMatchObject({ requiredPrepublishPluginPackages: [], credentials: [] });
    },
  );

  it("reads content-addressed scenario catalogs from pre-command frozen targets", () => {
    const { root, write, survivor, freeze } = targetFixture();
    const legacyScenarios = (
      "base feishu-channel bootstrap-persona channel-post-core-restore " +
      "plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path versioned-runtime-deps"
    ).split(" ");
    writeLegacyScenarioContract(root, legacyScenarios);

    const plan = survivor("2026.6.11", "reported-issues", { frozenTarget: freeze() });

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
    write("scripts/lib/upgrade-survivor-scenarios.json", "invalid current catalog");
    expect(() =>
      survivor("2026.6.11", "base", { allowFrozenTargetScenarioOmissions: false }),
    ).toThrow(/unrecognized scenario contract/);
  });

  it("recognizes the frozen combined mobile and watch scenario catalog", () => {
    const { root, plan: selected } = targetFixture();
    const scenarios = (
      "base mobile-pairing-reconnect acpx-openclaw-tools-bridge feishu-channel " +
      "bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup " +
      "configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path " +
      "meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume " +
      "recovery-cleanup auth-profile-v2026-7-2-beta-5 watchos-direct-node"
    ).split(" ");
    writeLegacyScenarioContract(root, scenarios);

    const plan = selected("update-migration", {
      upgradeSurvivorBaselines: "2026.7.1 2026.8.1",
      upgradeSurvivorScenarios: "mobile-pairing-reconnect watchos-direct-node",
    });

    expectPlanLanes(
      plan,
      ["update-migration-2026.8.1-watchos-direct-node"],
      [
        "update-migration-2026.7.1-mobile-pairing-reconnect",
        "update-migration-2026.8.1-mobile-pairing-reconnect",
      ],
    );
  });

  it.each([false, true])(
    "keeps mobile pairing with approved iPhone watch relay support: %s",
    (approved) => {
      const { write, plan } = targetFixture(["base"]);
      if (approved) {
        write(
          "src/gateway/node-command-policy.ts",
          'const commands = ["watch.status", "watch.notify"];\nplatformId === "ios";\nnormalizeDeviceMetadataForPolicy(node?.deviceFamily) === "iphone";\nnew Set([...watchRelayCommands]);\n',
        );
      }
      expectPlanLanes(
        plan("update-migration", {
          upgradeSurvivorBaselines: "2026.7.1",
          upgradeSurvivorScenarios: "mobile-pairing-reconnect",
          allowFrozenTargetScenarioOmissions: approved,
        }),
        ["update-migration-2026.7.1-mobile-pairing-reconnect"],
        approved ? undefined : [],
      );
    },
  );

  it("reports an explicitly selected expanded survivor lane as unsupported", () => {
    const { plan } = targetFixture(["unrelated"]);

    const selectedLane = "published-upgrade-survivor-2026.6.11";
    expectPlanLanes(
      plan(selectedLane, {
        upgradeSurvivorBaselines: "2026.6.11",
      }),
      [],
      [selectedLane],
    );
  });

  it.each([
    [
      'const SCENARIOS = new Set(["base"]);\nthrow new Error("unknown upgrade-survivor assertion command: list-scenarios");',
      "unknown upgrade-survivor assertion command: list-scenarios",
    ],
    ['process.stdout.write("base");\n', "list-scenarios did not return JSON"],
    [
      'process.stdout.write("[\\"base\\",\\"base\\"]");\n',
      "list-scenarios returned an invalid catalog",
    ],
  ])("fails closed on frozen target command failure: %s", (source, message) => {
    const { write, plan } = targetFixture();
    write("scripts/e2e/lib/upgrade-survivor/assertions.mjs", source);

    expect(() =>
      plan("published-upgrade-survivor", { upgradeSurvivorScenarios: "reported-issues" }),
    ).toThrow(message);
  });

  it("excludes Open WebUI from skip-live Docker all plans", () => {
    expect(laneNames(planFor({ liveMode: "skip" }))).not.toContain("openwebui");
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
