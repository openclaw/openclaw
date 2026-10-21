import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseArgs, resolveBaselines } from "../../scripts/resolve-upgrade-survivor-baselines.mts";

type Steps = Array<{ id?: string; run?: string }>;
type Workflow = {
  on: {
    workflow_call: {
      inputs: Record<
        "published_upgrade_survivor_baseline" | "published_upgrade_survivor_baselines",
        { default: string }
      >;
    };
  };
  jobs: { resolve_package: { steps: Steps } };
};
const workflow = () =>
  parse(readFileSync(".github/workflows/package-acceptance.yml", "utf8")) as Workflow;
const readOutputs = (file: string) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

let root: string;
let bin: string;
let output: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "openclaw-upgrade-baselines-"));
  bin = path.join(root, "bin");
  output = path.join(root, "output");
  mkdirSync(bin);
  writeFileSync(output, "");
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

function shell(script: string, env: NodeJS.ProcessEnv, cwd?: string) {
  return execFileSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: output,
      TARGET_CONTEXT_REF: "",
      ...env,
    },
  });
}

type BaselineFixture = {
  args?: Record<string, string | undefined>;
  releases?: string[];
  versions?: string[];
  tags?: Record<string, string | undefined>;
};
const yearVersions = (list: string) => list.split(" ").map((version) => `2026.${version}`);
function baseline(
  name: string,
  requested: string,
  releases: string,
  expected: string,
  extra: BaselineFixture = {},
) {
  return {
    name,
    args: { requested },
    releases: yearVersions(releases),
    expected: yearVersions(expected),
    ...extra,
  };
}
function unsupportedLine(
  tags: BaselineFixture["tags"],
  versions: string,
  error = "npm extended-stable must name a published extended-stable version",
) {
  return { args: { requested: "supported-lines" }, tags, versions: yearVersions(versions), error };
}

function resolveFixture({ args = {}, releases, versions, tags }: BaselineFixture) {
  const params = new Map(
    Object.entries(args).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const [key, value] of [
    [
      "releases-json",
      releases?.map((version, index) => ({
        tagName: `v${version}`,
        publishedAt: new Date(Date.UTC(2026, 8, 30 - index)).toISOString(),
        isPrerelease: version.includes("-beta."),
      })),
    ],
    ["npm-versions-json", versions],
    ["npm-dist-tags-json", tags],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    const metadata = path.join(root, `${key}.json`);
    writeFileSync(metadata, JSON.stringify(value));
    params.set(key, metadata);
  }
  return resolveBaselines(params);
}

describe("scripts/resolve-upgrade-survivor-baselines", () => {
  it.each([false, true])(
    "discovers all release pages before publishing baselines (API failure: %s)",
    (failApi) => {
      const run = workflow().jobs.resolve_package.steps.find(
        (step) => step.id === "upgrade_survivor_baselines",
      )?.run;
      assert(run);
      // Mixed prereleases put the requested cutoff beyond the first 100 records.
      const releases = Array.from({ length: 130 }, (_, index) => {
        const publishedAt = new Date(Date.UTC(2026, 8, 30) - index * 86_400_000);
        const version = `${publishedAt.getUTCFullYear()}.${publishedAt.getUTCMonth() + 1}.${publishedAt.getUTCDate()}`;
        return {
          tagName: `v${version}${index % 3 === 0 ? "-beta.1" : ""}`,
          publishedAt: publishedAt.toISOString(),
          isPrerelease: index % 3 === 0,
        };
      });
      const versions = releases
        .filter((release) => !release.isPrerelease && release.tagName !== "v2026.6.3")
        .map((release) => release.tagName.slice(1));
      const file = path.join(root, "releases.json");
      writeFileSync(file, JSON.stringify(releases));
      mkdirSync(path.join(root, ".artifacts/package-candidate-input"), { recursive: true });
      mkdirSync(path.join(root, "scripts"));
      copyFileSync(
        "scripts/resolve-upgrade-survivor-baselines.mts",
        path.join(root, "scripts/resolve-upgrade-survivor-baselines.mts"),
      );
      symlinkSync(path.resolve("scripts/lib"), path.join(root, "scripts/lib"));
      mkdirSync(path.join(root, "node_modules"));
      symlinkSync(
        path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
        path.join(root, "node_modules/tsx"),
        "junction",
      );
      writeFileSync(
        path.join(bin, "npm"),
        `#!/bin/sh\nprintf '%s' '${JSON.stringify(versions)}'\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const releases = JSON.parse(fs.readFileSync(process.env.RELEASE_FIXTURE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "release") {
  console.log(JSON.stringify(releases.slice(0, Number(args[args.indexOf("--limit") + 1]))));
} else {
  require("node:assert/strict").deepEqual(args, ["api", "--paginate", "--slurp", "repos/openclaw/openclaw/releases?per_page=100"]);
  const pages = [releases.slice(0, 100), releases.slice(100)].map(page => page.map(release => ({
    tag_name: release.tagName, published_at: release.publishedAt, prerelease: release.isPrerelease,
  })));
  console.log(JSON.stringify(process.env.FAIL_API === "true" ? pages.slice(0, 1) : pages));
}
if (process.env.FAIL_API === "true") process.exit(75);
`,
        { mode: 0o755 },
      );
      const invoke = () =>
        shell(
          run,
          {
            RELEASE_FIXTURE: file,
            FAIL_API: String(failApi),
            FALLBACK_BASELINE: "openclaw@2026.6.1",
            REQUESTED_BASELINES: "all-since-2026.6.1",
            CANDIDATE_VERSION: "2026.10.1",
            CANDIDATE_PUBLISHED: "false",
            GITHUB_REPOSITORY: "openclaw/openclaw",
            RUNNER_TEMP: root,
          },
          root,
        );
      if (failApi) {
        expect(invoke).toThrow();
        expect(readFileSync(output, "utf8")).toBe("");
      } else {
        invoke();
        const expected = releases
          .filter(
            (release) =>
              release.publishedAt >= "2026-06-01T00:00:00.000Z" &&
              versions.includes(release.tagName.slice(1)),
          )
          .map((release) => release.tagName.slice(1));
        expect(readFileSync(output, "utf8")).toBe(
          `baselines=${expected.map((version) => `openclaw@${version}`).join(" ")}\nbaseline_scope=all-scenarios\nbaseline=openclaw@2026.6.1\n`,
        );
      }
    },
  );

  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--fallback", "-h"])).toThrow("missing value for --fallback");
    expect(() => parseArgs(["--github-output", "-h"])).toThrow("missing value for --github-output");
  });

  it.each([
    "package",
    "update-migration",
    "padded",
    "comma",
    "repeated",
    "release-checks",
    "minimum",
  ])("pins the %s workflow baseline once before Docker fanout", (entrypoint) => {
    const packageWorkflow = workflow();
    const migration = parse(readFileSync(".github/workflows/update-migration.yml", "utf8")) as {
      on: { workflow_dispatch: { inputs: { baselines: { default: string } } } };
    };
    const inputs = packageWorkflow.on.workflow_call.inputs;
    const release = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    ) as {
      jobs: {
        package_acceptance_release_checks: {
          with: { published_upgrade_survivor_baselines: string };
        };
        prepare_release_package: {
          outputs: { upgrade_survivor_baselines: string };
          steps: Steps;
        };
      };
    };
    const run = packageWorkflow.jobs.resolve_package.steps.find(
      (entry) => entry.id === "upgrade_survivor_baselines",
    )?.run;
    assert(run, "Missing baseline preparation step");
    const standaloneSelectors = new Map([
      ["padded", " supported-lines "],
      ["comma", " , supported-lines, "],
      ["repeated", "supported-lines, supported-lines"],
    ]);
    let requested =
      standaloneSelectors.get(entrypoint) ??
      (entrypoint === "update-migration"
        ? migration.on.workflow_dispatch.inputs.baselines.default
        : entrypoint === "release-checks"
          ? ""
          : entrypoint === "minimum"
            ? "2026.6.1"
            : inputs.published_upgrade_survivor_baselines.default);

    const calls = path.join(root, "npm-calls");
    writeFileSync(
      path.join(bin, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FIXTURE_NPM_CALLS;
fs.appendFileSync(file, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify(process.argv[4] === "dist-tags"
  ? [{ latest: "2026.9.2", "extended-stable": "2026.8.35" }]
  : ["2026.6.34", "2026.7.1-2", "2026.8.1", "2026.8.33", "2026.8.35", "2026.9.1", "2026.9.2"]));
`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 75\n", { mode: 0o755 });
    if (entrypoint === "release-checks") {
      expect(
        release.jobs.package_acceptance_release_checks.with.published_upgrade_survivor_baselines,
      ).toBe("${{ needs.prepare_release_package.outputs.upgrade_survivor_baselines }}");
      expect(release.jobs.prepare_release_package.outputs.upgrade_survivor_baselines).toBe(
        "${{ steps.upgrade_survivor_profile.outputs.baselines }}",
      );
      const profile = release.jobs.prepare_release_package.steps.find(
        (entry) => entry.id === "upgrade_survivor_profile",
      );
      assert(profile?.run, "Missing release survivor profile producer");
      const profileOutput = path.join(root, "profile-output");
      writeFileSync(profileOutput, "");
      shell(profile.run, {
        CANDIDATE_PUBLISHED: "true",
        CANDIDATE_REF: "v2026.8.1",
        CANDIDATE_SOURCE_SHA: "a".repeat(40),
        CANDIDATE_VERSION: "2026.8.1",
        PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "",
        RUN_RELEASE_SOAK: "false",
        GITHUB_OUTPUT: profileOutput,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        FIXTURE_NPM_CALLS: calls,
      });
      const selected = readOutputs(profileOutput);
      expect(selected.baselines).toBe("");
      assert(selected.baselines !== undefined, "Missing release baseline output");
      requested = selected.baselines;
    }
    shell(run, {
      CANDIDATE_PUBLISHED: "true",
      CANDIDATE_VERSION: "2026.8.1",
      FALLBACK_BASELINE: inputs.published_upgrade_survivor_baseline.default,
      REQUESTED_BASELINES: requested,
      FIXTURE_NPM_CALLS: calls,
      RUNNER_TEMP: root,
    });
    const expanded = entrypoint === "update-migration" || standaloneSelectors.has(entrypoint);
    const expectedBaselines = expanded
      ? "openclaw@2026.9.2 openclaw@2026.9.1 openclaw@2026.8.35 openclaw@2026.6.34"
      : `openclaw@${entrypoint === "minimum" ? "2026.6.1" : "2026.7.1-2"}`;
    expect(readFileSync(output, "utf8")).toBe(
      `baselines=${expectedBaselines}\nbaseline_scope=${expanded ? "legacy-operator-state" : "all-scenarios"}\nbaseline=openclaw@2026.7.1-2\n`,
    );
    if (expanded) {
      const selected = readOutputs(output);
      const groups = JSON.parse(
        execFileSync(process.execPath, ["scripts/plan-targeted-docker-lane-groups.mjs"], {
          encoding: "utf8",
          env: {
            ...process.env,
            LANES: "update-migration",
            GROUP_SIZE: "1",
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: selected.baseline,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: selected.baselines,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SCOPE: selected.baseline_scope,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "plugin-deps-cleanup legacy-operator-state",
          },
        }),
      ) as Array<{
        published_upgrade_survivor_baselines: string;
        published_upgrade_survivor_scenarios: string;
      }>;
      expect(
        groups.map((group) => [
          group.published_upgrade_survivor_baselines,
          group.published_upgrade_survivor_scenarios,
        ]),
      ).toEqual([
        ["openclaw@2026.9.2", "legacy-operator-state"],
        ["openclaw@2026.9.1", "legacy-operator-state"],
        ["openclaw@2026.8.35", "legacy-operator-state"],
        ["openclaw@2026.6.34", "legacy-operator-state"],
        ["openclaw@2026.7.1-2", "plugin-deps-cleanup"],
      ]);
    }
    expect(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"],
      ...(expanded
        ? [["view", "openclaw", "dist-tags", "--json", "--silent", "--prefer-online"]]
        : []),
    ]);
  });

  it.each<BaselineFixture & { name: string; expected: string[] }>([
    { name: "fallback", args: { fallback: "2026.6.1" }, expected: ["2026.6.1"] },
    ...[undefined, "8.35", "8.33"].map((extended) => ({
      name: `supported lines with extended-stable ${extended}`,
      args: { requested: "supported-lines" },
      tags: { latest: "2026.9.2", ...(extended ? { "extended-stable": `2026.${extended}` } : {}) },
      versions: yearVersions("6.34 8.33 8.35 9.1 9.2 9.3-beta.1 9.3"),
      expected: yearVersions(`9.2 9.1${extended ? ` ${extended}` : ""} 6.34`),
    })),
    {
      name: "supported lines excluding unpublished candidate",
      args: {
        requested: "supported-lines",
        "candidate-version": "2026.9.3",
        "candidate-published": "false",
      },
      tags: { latest: "2026.9.3" },
      versions: ["2026.6.34", "2026.8.33", "2026.9.2", "2026.9.3"],
      expected: ["2026.9.2", "2026.6.34"],
    },
    baseline(
      "six supported stable releases, deduplicating explicit versions",
      "release-history 2026.6.6",
      "6.6 6.5 6.4 6.3 6.2 6.1 4.23 3.13-1 3.12 6.7-beta.1",
      "6.6 6.5 6.4 6.3 6.2 6.1",
    ),
    ...["release-history", "last-stable-4"].map((requested) => ({
      name: `${requested} count excluding unpublished candidate`,
      args: {
        requested,
        "candidate-version": "2026.9.4",
        "candidate-published": "false",
        "history-count": "4",
      },
      releases: yearVersions("9.4 9.3 9.2 9.1 8.30"),
      versions: requested === "last-stable-4" ? yearVersions("8.30 9.1 9.2 9.3 9.4") : undefined,
      expected: yearVersions("9.3 9.2 9.1 8.30"),
    })),
    baseline(
      "all published stable releases since the cutoff",
      "all-since-2026.6.2",
      "6.5 6.4 6.3 6.2 6.1 6.6-beta.1",
      "6.5 6.4 6.3 6.2",
      { versions: yearVersions("6.5 6.4 6.3 6.2 6.1") },
    ),
    baseline(
      "latest stable packages with explicit older versions",
      "last-stable-4 2026.6.23 2026.7.2 2026.6.15",
      "7.4-beta.1 7.3-1 7.3 7.2 6.29 6.27 6.15",
      "7.3-1 7.3 7.2 6.29 6.23 6.15",
      { versions: yearVersions("7.3-1 7.3 7.2 6.29 6.27 6.15") },
    ),
    baseline(
      "regular stable selection excluding extended-stable releases",
      "last-stable-1",
      "6.34 7.12",
      "7.12",
    ),
    baseline(
      "release history excluding unsafe and unsupported tags",
      "release-history",
      "6.9007199254740993 6.29 5.31",
      "6.29",
      { args: { requested: "release-history", "history-count": "2" } },
    ),
    baseline(
      "republish tags mapped to published package versions",
      "release-history",
      "6.3-1 6.2",
      "6.3 6.2",
      { versions: yearVersions("6.3 6.2") },
    ),
  ])("resolves $name", ({ expected, ...fixture }) => {
    expect(resolveFixture(fixture)).toEqual(expected.map((version) => `openclaw@${version}`));
  });

  it.each<BaselineFixture & { error: string }>([
    ...[
      { requested: "2026.5.31" },
      { fallback: "openclaw@2026.5.31-beta.1" },
      { requested: "all-since-2026.5.31" },
    ].map((args) => ({
      args,
      error: "Upgrade pre-June installs through OpenClaw 2026.9.5 and run Doctor first",
    })),
    unsupportedLine({}, "8.33 9.2", "npm latest must name a published stable version"),
    unsupportedLine({ latest: "2026.9.2", "extended-stable": "2026.8.99" }, "6.34 8.33 9.1 9.2"),
    ...["9.1", "8.35-1", "8.35-beta.1"].map((extended) =>
      unsupportedLine(
        { latest: "2026.9.2", "extended-stable": `2026.${extended}` },
        `6.34 8.33 9.1 9.2 ${extended}`,
      ),
    ),
    unsupportedLine(
      { latest: "2026.9.2" },
      "9.1 9.2",
      "oldest supported baseline is not published",
    ),
    {
      args: { requested: "release-history", "history-count": "1e3" },
      releases: [],
      error: "--history-count must be a positive integer",
    },
    {
      args: { requested: "last-stable-1e3" },
      releases: [],
      error: "last-stable baseline count must be a positive integer",
    },
    {
      args: { requested: "all-since-2026.6.9007199254740993" },
      releases: [],
      error: "invalid all-since baseline token: all-since-2026.6.9007199254740993",
    },
  ])("rejects unusable baseline inputs: $args $tags", ({ error, ...fixture }) => {
    expect(() => resolveFixture(fixture)).toThrow(error);
  });
});
