// Catalog Compare Released tests cover the baseline-vs-candidate diff of released reader
// observations and the CLI's release install cache.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffRuns,
  formatReport,
  type ReleaseRun,
  type RowObservation,
} from "../../scripts/lib/catalog-compare-released-diff.mts";
import {
  catalogRowCount,
  releasedReaderVerdict,
  releasedSchemaVersions,
} from "../../scripts/lib/catalog-compare-released-gate.mts";

function kimiRow(highEffort: string): RowObservation {
  const request = (effort: string) => ({
    outcome: "stop",
    calls: [
      {
        method: "POST",
        url: "https://api.moonshot.ai/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: {
          model: "kimi-k3",
          stream: true,
          reasoning_effort: effort,
          messages: [{ role: "user", content: "hi" }],
        },
      },
    ],
  });
  return {
    model: "moonshot/kimi-k3",
    source: "catalog-row",
    runtimeModel: { id: "kimi-k3", thinkingLevelMap: { low: "low", high: highEffort } },
    profiles: {
      openclaw: { offered: ["low", "high"], default: "low" },
      codex: { offered: ["low", "high"], default: "low" },
    },
    requests: { low: request("low"), high: request(highEffort) },
  };
}

const run = (rows: RowObservation[]): ReleaseRun => ({
  version: "2026.10.8",
  refresh: { status: "updated", generatedAt: 1 },
  rows,
});

describe("catalog compare released diff", () => {
  it("reports nothing for identical observations", () => {
    expect(diffRuns(run([kimiRow("high")]), run([kimiRow("high")]))).toEqual([]);
  });

  it("names each changed field with its level, and listed or dropped rows", () => {
    const other: RowObservation = { ...kimiRow("high"), model: "moonshot/kimi-k2" };
    const changes = diffRuns(run([kimiRow("high"), other]), run([kimiRow("max")]));

    expect(changes.filter((change) => change.model === "moonshot/kimi-k3")).toEqual([
      {
        release: "2026.10.8",
        model: "moonshot/kimi-k3",
        level: "-",
        field: "model.thinkingLevelMap.high",
        before: "high",
        after: "max",
      },
      {
        release: "2026.10.8",
        model: "moonshot/kimi-k3",
        level: "high",
        field: "request.body.reasoning_effort",
        before: "high",
        after: "max",
      },
    ]);
    expect(
      changes.find((change) => change.model === "moonshot/kimi-k2" && change.field === "row"),
    ).toMatchObject({
      before: "listed",
      after: undefined,
    });
    expect(formatReport([{ release: "2026.10.8", label: "latest", changes }]).split("\n")).toEqual([
      `2026.10.8 (latest): ${changes.length} changed fields`,
      `  moonshot/kimi-k2  -  row: "listed" → (absent) (${changes.length - 2} fields)`,
      '  moonshot/kimi-k3  -  model.thinkingLevelMap.high: "high" → "max"',
      '  moonshot/kimi-k3  high  request.body.reasoning_effort: "high" → "max"',
    ]);
  });
});

// A fake npm that installs a release listing one provider, then fails that
// provider's registry lookup the way a timeout does (not E404).
const FAKE_NPM = `#!/bin/sh
case "$1" in
  install)
    for spec in "$@"; do
      case "$spec" in openclaw@*)
        mkdir -p node_modules/openclaw/dist
        echo '"official-external-provider-catalog.json" "npmSpec": "@openclaw/foo-provider"' > node_modules/openclaw/dist/listing.mjs
      ;; esac
    done ;;
  view)
    echo "npm error code ETIMEDOUT" >&2
    exit 1 ;;
esac
`;

describe("catalog compare released install cache", () => {
  it.each([
    ["no cached install", false],
    ["a stale marker that misses a listed provider", true],
  ])("fails setup on a non-404 provider lookup with %s", (_name, seedStaleMarker) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catalog-compare-test-")));
    try {
      const bin = path.join(root, "bin");
      const tmp = path.join(root, "tmp");
      fs.mkdirSync(bin);
      fs.mkdirSync(tmp);
      fs.writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
      const bundle = path.join(root, "bundle.json");
      fs.writeFileSync(bundle, "{}");
      const release = path.join(tmp, "openclaw-catalog-compare-released/2099.1.1");
      if (seedStaleMarker) {
        fs.mkdirSync(path.join(release, "node_modules/openclaw/dist"), { recursive: true });
        fs.writeFileSync(
          path.join(release, "node_modules/openclaw/dist/listing.mjs"),
          '"official-external-provider-catalog.json" "npmSpec": "@openclaw/foo-provider"',
        );
        fs.writeFileSync(
          path.join(release, ".installed"),
          JSON.stringify({ plugins: [], omitted: [] }),
        );
      }

      const result = spawnSync(
        process.execPath,
        [
          "scripts/catalog-compare-released.mts",
          "--candidate",
          bundle,
          "--baseline",
          bundle,
          "--releases",
          "2099.1.1",
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: root,
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            TMPDIR: tmp,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("npm view @openclaw/foo-provider@2099.1.1 failed");
      expect(fs.existsSync(path.join(release, ".installed"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("catalog compare released publish gate", () => {
  const updated = (models: number) => ({ status: "updated", models });
  const verdict = (candidate: [number, object], baseline?: [number, object], allowRowLoss = 0) =>
    releasedReaderVerdict({
      feed: "v2",
      release: "2026.11.5-beta.1",
      candidate: { emitted: candidate[0], refresh: candidate[1] },
      ...(baseline ? { baseline: { emitted: baseline[0], refresh: baseline[1] } } : {}),
      allowRowLoss,
    }).failure;

  it.each([
    // Audit: beta salvaged rows of v2-20-enum-pricing-status and reported updated.
    [
      "a dropped published row",
      verdict([1244, updated(1243)], [1244, updated(1244)]),
      "release dropped 1 of 1244 published rows (allowed 0)",
    ],
    [
      "a loss the last published file already had",
      verdict([1262, updated(1261)], [1261, updated(1260)]),
      undefined,
    ],
    ["an allowed new loss", verdict([1262, updated(1260)], [1261, updated(1260)], 1), undefined],
    [
      "a loss next to a rejected baseline",
      verdict([1262, updated(1261)], [1261, { status: "error" }]),
      "release dropped 1 of 1262",
    ],
    ["a rejection", verdict([1244, { status: "error", error: "bad\n  key" }]), "error: bad key"],
  ])("judges %s", (_name, failure, expected) => {
    if (expected === undefined) {
      expect(failure).toBeUndefined();
    } else {
      expect(failure).toContain(expected);
    }
  });

  it("counts rows and finds wire readers by the source names main declares", () => {
    expect(catalogRowCount({ providers: { a: { models: [{}, {}] }, b: { models: [{}] } } })).toBe(
      3,
    );
    expect(catalogRowCount({ schemaVersion: 3, models: [{}, {}] })).toBe(2);
    const source = fs.readFileSync(
      "packages/model-catalog-core/src/remote-catalog-bundle.ts",
      "utf8",
    );
    expect(releasedSchemaVersions([source])).toEqual(new Set([1, 2, 3]));
  });
});

describe("catalog compare released --check", () => {
  // Fake releases that list no provider plugins and ship only v1/v2 readers.
  function runCheck(schemaVersion: number, args: string[]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catalog-check-test-")));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, "tmp"));
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!/bin/sh
[ "$1" = install ] && mkdir -p node_modules/openclaw/dist && echo '"official-external-provider-catalog.json" function validateAndSanitizeRemoteModelCatalogBundleV2(' > node_modules/openclaw/dist/listing.mjs
exit 0
`,
      { mode: 0o755 },
    );
    const bundle = path.join(root, "bundle.json");
    fs.writeFileSync(bundle, JSON.stringify({ schemaVersion, providers: {}, models: [{}] }));
    const result = spawnSync(
      process.execPath,
      ["scripts/catalog-compare-released.mts", "--check", "--candidate", bundle, ...args],
      {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          TMPDIR: path.join(root, "tmp"),
        },
      },
    );
    fs.rmSync(root, { recursive: true, force: true });
    return result;
  }

  it("skips releases without a reader for the candidate's wire version, by name", () => {
    const result = runCheck(3, ["--releases", "2099.1.1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "v3 on openclaw@2099.1.1: no v3 reader, skipped",
      "v3: no checked release reads v3 yet",
    ]);
  });
});
