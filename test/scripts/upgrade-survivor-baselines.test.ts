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
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseArgs, resolveBaselines } from "../../scripts/resolve-upgrade-survivor-baselines.mts";

function withReleaseFixture<T>(releases: unknown[], fn: (file: string) => T): T {
  return withJsonFixture("releases.json", releases, fn);
}

function withJsonFixture<T>(name: string, contents: unknown, fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-upgrade-baselines-"));
  try {
    const file = path.join(dir, name);
    writeFileSync(file, `${JSON.stringify(contents)}\n`);
    return fn(file);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

type BaselineFixture = {
  args?: Record<string, string | undefined>;
  releases?: string[];
  versions?: string[];
  tags?: Record<string, string | undefined>;
};

function resolveFixture({ args = {}, releases, versions, tags }: BaselineFixture) {
  return withJsonFixture("fixture.json", null, (file) => {
    const params = new Map<string, string>();
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }
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
      const metadata = path.join(path.dirname(file), `${key}.json`);
      writeFileSync(metadata, JSON.stringify(value));
      params.set(key, metadata);
    }
    return resolveBaselines(params);
  });
}

describe("scripts/resolve-upgrade-survivor-baselines", () => {
  it.each([false, true])(
    "discovers all release pages before publishing baselines (API failure: %s)",
    (failApi) => {
      const workflow = parse(readFileSync(".github/workflows/package-acceptance.yml", "utf8")) as {
        jobs: { resolve_package: { steps: Array<{ id?: string; run?: string }> } };
      };
      const run = workflow.jobs.resolve_package.steps.find(
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
      withReleaseFixture(releases, (file) => {
        const root = path.dirname(file);
        const bin = path.join(root, "bin");
        const output = path.join(root, "output");
        mkdirSync(bin);
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
        writeFileSync(output, "");
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
          execFileSync("bash", ["-c", run], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RELEASE_FIXTURE: file,
              FAIL_API: String(failApi),
              FALLBACK_BASELINE: "openclaw@2026.6.1",
              REQUESTED_BASELINES: "all-since-2026.6.1",
              CANDIDATE_VERSION: "2026.10.1",
              CANDIDATE_PUBLISHED: "false",
              GITHUB_REPOSITORY: "openclaw/openclaw",
              GITHUB_OUTPUT: output,
              RUNNER_TEMP: root,
              TARGET_CONTEXT_REF: "",
            },
          });
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
      });
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
    const workflow = parse(readFileSync(".github/workflows/package-acceptance.yml", "utf8")) as {
      on: {
        workflow_call: {
          inputs: Record<
            "published_upgrade_survivor_baseline" | "published_upgrade_survivor_baselines",
            { default: string }
          >;
        };
      };
      jobs: { resolve_package: { steps: Array<{ id?: string; run?: string }> } };
    };
    const migration = parse(readFileSync(".github/workflows/update-migration.yml", "utf8")) as {
      on: { workflow_dispatch: { inputs: { baselines: { default: string } } } };
    };
    const inputs = workflow.on.workflow_call.inputs;
    const release = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    ) as {
      jobs: {
        package_acceptance_release_checks: {
          with: { published_upgrade_survivor_baselines: string };
        };
        prepare_release_package: {
          outputs: { upgrade_survivor_baselines: string };
          steps: Array<{ id?: string; run?: string }>;
        };
      };
    };
    const step = workflow.jobs.resolve_package.steps.find(
      (entry) => entry.id === "upgrade_survivor_baselines",
    );
    const run = step?.run;
    if (!run) {
      throw new Error("Missing baseline preparation step");
    }
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

    withJsonFixture("output", {}, (output) => {
      const root = path.dirname(output);
      const bin = path.join(root, "bin");
      const calls = path.join(root, "npm-calls");
      mkdirSync(bin);
      writeFileSync(output, "");
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
        if (!profile?.run) {
          throw new Error("Missing release survivor profile producer");
        }
        const profileOutput = path.join(root, "profile-output");
        writeFileSync(profileOutput, "");
        execFileSync("bash", ["-c", profile.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            CANDIDATE_PUBLISHED: "true",
            CANDIDATE_REF: "v2026.8.1",
            CANDIDATE_SOURCE_SHA: "a".repeat(40),
            CANDIDATE_VERSION: "2026.8.1",
            PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "",
            RUN_RELEASE_SOAK: "false",
            TARGET_CONTEXT_REF: "",
            GITHUB_OUTPUT: profileOutput,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            FIXTURE_NPM_CALLS: calls,
          },
        });
        const selected = Object.fromEntries(
          readFileSync(profileOutput, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        // Historical qualification keeps the candidate-relative predecessor.
        expect(selected.baselines).toBe("");
        assert(selected.baselines !== undefined, "Missing release baseline output");
        requested = selected.baselines;
      }
      execFileSync("bash", ["-c", run], {
        encoding: "utf8",
        env: {
          ...process.env,
          CANDIDATE_PUBLISHED: "true",
          CANDIDATE_VERSION: "2026.8.1",
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FALLBACK_BASELINE: inputs.published_upgrade_survivor_baseline.default,
          REQUESTED_BASELINES: requested,
          GITHUB_OUTPUT: output,
          FIXTURE_NPM_CALLS: calls,
          RUNNER_TEMP: root,
          TARGET_CONTEXT_REF: "",
        },
      });
      const expanded = entrypoint === "update-migration" || standaloneSelectors.has(entrypoint);
      const expectedBaselines = expanded
        ? "openclaw@2026.9.2 openclaw@2026.9.1 openclaw@2026.8.35 openclaw@2026.6.34"
        : `openclaw@${entrypoint === "minimum" ? "2026.6.1" : "2026.7.1-2"}`;
      expect(readFileSync(output, "utf8")).toBe(
        `baselines=${expectedBaselines}\nbaseline_scope=${expanded ? "legacy-operator-state" : "all-scenarios"}\nbaseline=openclaw@2026.7.1-2\n`,
      );
      if (expanded) {
        const selected = Object.fromEntries(
          readFileSync(output, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
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
  });

  it.each<BaselineFixture & { name: string; expected: string[] }>([
    { name: "fallback", args: { fallback: "2026.6.1" }, expected: ["2026.6.1"] },
    ...[
      { extended: undefined, expected: ["2026.9.2", "2026.9.1", "2026.6.34"] },
      { extended: "2026.8.35", expected: ["2026.9.2", "2026.9.1", "2026.8.35", "2026.6.34"] },
      { extended: "2026.8.33", expected: ["2026.9.2", "2026.9.1", "2026.8.33", "2026.6.34"] },
    ].map(({ extended, expected }) => ({
      name: `supported lines with extended-stable ${extended}`,
      args: { requested: "supported-lines" },
      tags: { latest: "2026.9.2", ...(extended ? { "extended-stable": extended } : {}) },
      versions: [
        "2026.6.34",
        "2026.8.33",
        "2026.8.35",
        "2026.9.1",
        "2026.9.2",
        "2026.9.3-beta.1",
        "2026.9.3",
      ],
      expected,
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
    {
      name: "six supported stable releases, deduplicating explicit versions",
      args: { requested: "release-history 2026.6.6" },
      releases: [
        "2026.6.6",
        "2026.6.5",
        "2026.6.4",
        "2026.6.3",
        "2026.6.2",
        "2026.6.1",
        "2026.4.23",
        "2026.3.13-1",
        "2026.3.12",
        "2026.6.7-beta.1",
      ],
      expected: ["2026.6.6", "2026.6.5", "2026.6.4", "2026.6.3", "2026.6.2", "2026.6.1"],
    },
    ...["release-history", "last-stable-4"].map((requested) => ({
      name: `${requested} count excluding unpublished candidate`,
      args: {
        requested,
        "candidate-version": "2026.9.4",
        "candidate-published": "false",
        "history-count": "4",
      },
      releases: ["2026.9.4", "2026.9.3", "2026.9.2", "2026.9.1", "2026.8.30"],
      versions:
        requested === "last-stable-4"
          ? ["2026.8.30", "2026.9.1", "2026.9.2", "2026.9.3", "2026.9.4"]
          : undefined,
      expected: ["2026.9.3", "2026.9.2", "2026.9.1", "2026.8.30"],
    })),
    {
      name: "all published stable releases since the cutoff",
      args: { requested: "all-since-2026.6.2" },
      releases: ["2026.6.5", "2026.6.4", "2026.6.3", "2026.6.2", "2026.6.1", "2026.6.6-beta.1"],
      versions: ["2026.6.5", "2026.6.4", "2026.6.3", "2026.6.2", "2026.6.1"],
      expected: ["2026.6.5", "2026.6.4", "2026.6.3", "2026.6.2"],
    },
    {
      name: "latest stable packages with explicit older versions",
      args: { requested: "last-stable-4 2026.6.23 2026.7.2 2026.6.15" },
      releases: [
        "2026.7.4-beta.1",
        "2026.7.3-1",
        "2026.7.3",
        "2026.7.2",
        "2026.6.29",
        "2026.6.27",
        "2026.6.15",
      ],
      versions: ["2026.7.3-1", "2026.7.3", "2026.7.2", "2026.6.29", "2026.6.27", "2026.6.15"],
      expected: ["2026.7.3-1", "2026.7.3", "2026.7.2", "2026.6.29", "2026.6.23", "2026.6.15"],
    },
    {
      name: "regular stable selection excluding extended-stable releases",
      args: { requested: "last-stable-1" },
      releases: ["2026.6.34", "2026.7.12"],
      expected: ["2026.7.12"],
    },
    {
      name: "release history excluding unsafe and unsupported tags",
      args: { requested: "release-history", "history-count": "2" },
      releases: ["2026.6.9007199254740993", "2026.6.29", "2026.5.31"],
      expected: ["2026.6.29"],
    },
    {
      name: "republish tags mapped to published package versions",
      args: { requested: "release-history" },
      releases: ["2026.6.3-1", "2026.6.2"],
      versions: ["2026.6.3", "2026.6.2"],
      expected: ["2026.6.3", "2026.6.2"],
    },
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
    ...[
      {
        tags: {},
        versions: ["2026.8.33", "2026.9.2"],
        error: "npm latest must name a published stable version",
      },
      {
        tags: { latest: "2026.9.2", "extended-stable": "2026.8.99" },
        versions: ["2026.6.34", "2026.8.33", "2026.9.1", "2026.9.2"],
        error: "npm extended-stable must name a published extended-stable version",
      },
      ...["2026.9.1", "2026.8.35-1", "2026.8.35-beta.1"].map((extended) => ({
        tags: { latest: "2026.9.2", "extended-stable": extended },
        versions: ["2026.6.34", "2026.8.33", "2026.9.1", "2026.9.2", extended],
        error: "npm extended-stable must name a published extended-stable version",
      })),
      {
        tags: { latest: "2026.9.2" },
        versions: ["2026.9.1", "2026.9.2"],
        error: "oldest supported baseline is not published",
      },
    ].map(({ tags, versions, error }) => ({
      tags,
      versions,
      error,
      args: { requested: "supported-lines" },
    })),
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
