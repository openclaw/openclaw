// Plugin SDK Impact Policy tests cover PR impact classification and gate requirements.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classificationFromClawSweeperExactHead,
  evaluatePluginSdkImpact,
  extractOpenClawRfcPullNumbers,
  formatPluginSdkImpactFailure,
  isPluginSdkImpactPath,
  pluginSdkImpactRequirements,
} from "../../scripts/github/plugin-sdk-impact-policy.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_SHA = "89abcdef012345670123456789abcdef01234567";

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    body: "",
    base: { sha: BASE_SHA },
    head: { sha: HEAD_SHA },
    labels: [],
    ...overrides,
  };
}

function file(filename: string, patch = "") {
  return { filename, patch };
}

function renamedFile(filename: string, previousFilename: string, patch = "") {
  return { filename, patch, previous_filename: previousFilename, status: "renamed" };
}

function pathsHash(paths: string[]) {
  return createHash("sha256").update(paths.toSorted().join("\n")).digest("hex");
}

function clawsweeperMarker(classification: string, paths: string[], overrides = {}) {
  const fields = {
    base: BASE_SHA,
    paths: pathsHash(paths),
    sha: HEAD_SHA,
    ...overrides,
  };
  return `<!-- clawsweeper-plugin-sdk-impact sha=${fields.sha} base=${fields.base} paths=${fields.paths} classification=${classification} -->`;
}

describe("plugin-sdk-impact-policy", () => {
  it("detects plugin SDK impact paths", () => {
    expect(isPluginSdkImpactPath(file("src/plugin-sdk/core.ts"))).toBe(true);
    expect(isPluginSdkImpactPath(file("scripts/lib/plugin-sdk-entrypoints.json"))).toBe(true);
    expect(isPluginSdkImpactPath(file("scripts/generate-plugin-sdk-api-baseline.ts"))).toBe(true);
    expect(isPluginSdkImpactPath(file("docs/.generated/plugin-sdk-api-baseline.sha256"))).toBe(
      true,
    );
    expect(isPluginSdkImpactPath(file("package.json", '+    "./plugin-sdk/foo": {}'))).toBe(true);
    expect(isPluginSdkImpactPath({ filename: "package.json" })).toBe(true);
    expect(isPluginSdkImpactPath(file("src/plugins/types.ts"))).toBe(true);
    expect(isPluginSdkImpactPath(file("src/channels/plugins/catalog.ts"))).toBe(true);
    expect(isPluginSdkImpactPath(file("packages/markdown-core/src/ir.ts"))).toBe(true);
    expect(
      isPluginSdkImpactPath(renamedFile("src/internal/core.ts", "src/plugin-sdk/core.ts")),
    ).toBe(true);
    expect(isPluginSdkImpactPath(file("package.json", '+    "name": "openclaw"'))).toBe(false);
    expect(isPluginSdkImpactPath(file("src/agents/run.ts"))).toBe(false);
  });

  it("classifies non-impact PRs as not applicable", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/agents/run.ts")],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      applies: false,
      classification: "",
      classificationSource: "none",
    });
  });

  it("classifies test-only plugin SDK changes deterministically", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.test.ts"), file("test/scripts/foo.test.ts")],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:test-only",
      classificationSource: "deterministic",
    });
    expect(pluginSdkImpactRequirements(evaluation.classification)).toEqual({
      maintainerApproval: false,
      rfc: false,
    });
  });

  it("classifies public metadata additions as additive API", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("scripts/lib/plugin-sdk-entrypoints.json", '+  "new-subpath",')],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:additive-api",
      classificationSource: "deterministic",
    });
    expect(pluginSdkImpactRequirements(evaluation.classification)).toEqual({
      maintainerApproval: true,
      rfc: false,
    });
  });

  it("classifies API baseline hash replacements as breaking without additive metadata proof", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [
        file(
          "docs/.generated/plugin-sdk-api-baseline.sha256",
          "-oldhash  plugin-sdk-api-baseline.jsonl\n+newhash  plugin-sdk-api-baseline.jsonl",
        ),
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:breaking-change",
      classificationSource: "deterministic",
    });
  });

  it("classifies public metadata removals as breaking changes", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("scripts/lib/plugin-sdk-entrypoints.json", '-  "old-subpath",')],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:breaking-change",
      classificationSource: "deterministic",
    });
    expect(pluginSdkImpactRequirements(evaluation.classification)).toEqual({
      maintainerApproval: true,
      rfc: true,
    });
  });

  it("classifies renamed-away public metadata by its previous path", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [
        renamedFile(
          "scripts/lib/internal-entrypoints.json",
          "scripts/lib/plugin-sdk-entrypoints.json",
        ),
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:breaking-change",
      classificationSource: "deterministic",
      triggeredPaths: [
        "scripts/lib/internal-entrypoints.json",
        "scripts/lib/plugin-sdk-entrypoints.json",
      ],
    });
  });

  it("classifies adding private-local-only SDK metadata as breaking", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [
        file("scripts/lib/plugin-sdk-private-local-only-subpaths.json", '+  "old-subpath",'),
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:breaking-change",
      classificationSource: "deterministic",
    });
  });

  it("classifies removing private-local-only SDK metadata as additive", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [
        file("scripts/lib/plugin-sdk-private-local-only-subpaths.json", '-  "new-subpath",'),
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:additive-api",
      classificationSource: "deterministic",
    });
  });

  it("classifies public metadata changes without patch text as breaking changes", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [{ filename: "package.json" }],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:breaking-change",
      classificationSource: "deterministic",
    });
  });

  it("classifies public entrypoint implementation changes as behavior changes", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "deterministic",
    });
  });

  it("classifies renamed-away public SDK entrypoints by their previous path", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [renamedFile("src/internal/core.ts", "src/plugin-sdk/core.ts")],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "deterministic",
      triggeredPaths: ["src/internal/core.ts", "src/plugin-sdk/core.ts"],
    });
  });

  it("classifies public SDK dependency graph changes as behavior changes", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("packages/markdown-core/src/ir.ts", "+export type Changed = true;")],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "deterministic",
    });
  });

  it("lets an exact-head ClawSweeper marker supersede deterministic classification", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      comments: [
        {
          body: clawsweeperMarker("plugin-sdk:architecture-change", ["src/plugin-sdk/core.ts"]),
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:architecture-change",
      classificationSource: "clawsweeper",
    });
  });

  it("lets an exact-head ClawSweeper marker lower conservative baseline classification", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [
        file(
          "docs/.generated/plugin-sdk-api-baseline.sha256",
          "-oldhash  plugin-sdk-api-baseline.jsonl\n+newhash  plugin-sdk-api-baseline.jsonl",
        ),
      ],
      comments: [
        {
          body: clawsweeperMarker("plugin-sdk:additive-api", [
            "docs/.generated/plugin-sdk-api-baseline.sha256",
          ]),
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:additive-api",
      classificationSource: "clawsweeper",
    });
  });

  it("ignores stale ClawSweeper markers with the wrong base", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      comments: [
        {
          body: clawsweeperMarker("plugin-sdk:private-only", ["src/plugin-sdk/core.ts"], {
            base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "deterministic",
    });
  });

  it("uses the latest matching ClawSweeper marker", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      comments: [
        {
          body: clawsweeperMarker("plugin-sdk:private-only", ["src/plugin-sdk/core.ts"]),
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
        {
          body: clawsweeperMarker("plugin-sdk:architecture-change", ["src/plugin-sdk/core.ts"]),
          performed_via_github_app: { slug: "clawsweeper" },
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
      pullRequest: pullRequest(),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:architecture-change",
      classificationSource: "clawsweeper",
    });
  });

  it("lets a classification label raise deterministic severity", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      pullRequest: pullRequest({ labels: [{ name: "plugin-sdk:architecture-change" }] }),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:architecture-change",
      classificationSource: "label",
    });
  });

  it("does not let a classification label lower deterministic severity", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      pullRequest: pullRequest({ labels: [{ name: "plugin-sdk:private-only" }] }),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "deterministic",
    });
    expect(evaluation.error).toContain("lower than deterministic classification");
  });

  it("rejects multiple plugin SDK classification labels", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      pullRequest: pullRequest({
        labels: [{ name: "plugin-sdk:private-only" }, { name: "plugin-sdk:behavior-change" }],
      }),
    });

    expect(evaluation.error).toContain("Multiple plugin SDK classification labels");
  });

  it("accepts PR body classification when no label or exact-head marker exists", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      pullRequest: pullRequest({ body: "Plugin SDK impact: behavior-change" }),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "body",
    });
  });

  it("does not let PR body classification lower deterministic severity", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("src/plugin-sdk/core.ts", "+export const changed = true;")],
      pullRequest: pullRequest({ body: "Plugin SDK impact: private-only" }),
    });

    expect(evaluation).toMatchObject({
      classification: "plugin-sdk:behavior-change",
      classificationSource: "deterministic",
    });
    expect(evaluation.error).toContain("lower than deterministic classification");
  });

  it("extracts openclaw/rfcs pull request links", () => {
    expect(
      extractOpenClawRfcPullNumbers(
        "RFC: https://github.com/openclaw/rfcs/pull/7\nNot RFC: https://github.com/openclaw/openclaw/pull/7",
      ),
    ).toEqual([7]);
  });

  it("formats failure output with trigger files and requirements", () => {
    const evaluation = evaluatePluginSdkImpact({
      changedFiles: [file("scripts/lib/plugin-sdk-entrypoints.json", '-  "old-subpath",')],
      pullRequest: pullRequest(),
    });

    expect(
      formatPluginSdkImpactFailure({
        approvalPassed: false,
        evaluation,
        rfcPassed: false,
        rfcPullNumbers: [],
      }),
    ).toContain("RFC required: yes");
    expect(
      formatPluginSdkImpactFailure({
        approvalPassed: false,
        evaluation,
        rfcPassed: false,
        rfcPullNumbers: [],
      }),
    ).toContain("scripts/lib/plugin-sdk-entrypoints.json");
  });

  it("exposes exact-head ClawSweeper classification directly", () => {
    expect(
      classificationFromClawSweeperExactHead({
        comments: [
          {
            body: clawsweeperMarker("additive-api", []),
            performed_via_github_app: { slug: "clawsweeper" },
            user: { login: "clawsweeper[bot]", type: "Bot" },
          },
        ],
        pullRequest: pullRequest(),
      }),
    ).toBe("plugin-sdk:additive-api");
  });
});
