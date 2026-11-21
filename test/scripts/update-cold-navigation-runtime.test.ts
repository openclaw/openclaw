import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  assertColdNavigationTrafficCoverage,
  planColdNavigationRuntime,
  type ColdRuntimeObservation,
} from "../../scripts/perf/update-cold-navigation-runtime.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir, trackTempDir } = createScriptTestHarness();
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

it("plans installed-runtime pairs without fixture mutations and rejects mismatched inputs", async () => {
  const root = createTempDir("cold-runtime-plan-");
  fs.mkdirSync(".openclaw/tmp", { recursive: true });
  const outputRoot = trackTempDir(path.resolve(".openclaw/tmp", path.basename(root)));
  const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));

  const pack = (name: string, agent = metadata.openclaw.schemaVersions.agent) => {
    const staging = path.join(root, name, "package");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(
      path.join(staging, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: name,
        openclaw: { schemaVersions: { ...metadata.openclaw.schemaVersions, agent } },
      }),
    );
    const tarball = path.join(root, name + ".tgz");
    execFileSync("tar", ["-czf", tarball, "-C", path.dirname(staging), "package"]);
    return {
      tarball,
      sha256: hash(tarball),
      sourceCommit: "a".repeat(40),
      sourceSnapshotSha256: "b".repeat(64),
      qualificationReceipt: "synthetic plan fixture, not a runnable package",
    };
  };
  const manifest = {
    version: 1,
    outputRoot,
    pairs: 5,
    nodeVersion: process.version,
    nodeSha256: hash(process.execPath),
    fixtureProducerSha256: hash("scripts/perf/update-doctor-generation-measure.ts"),
    baseline: pack("baseline"),
    candidate: pack("candidate"),
    controlledHost: {
      reservation: "plan test only",
      maxLoadPerCpu: 0.25,
      maxIoFullAvg10Percent: 1,
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  const invoke = (input: unknown) => {
    fs.writeFileSync(manifestPath, JSON.stringify(input));
    return execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/perf/update-doctor-generation-measure.ts",
        "test",
        "cold-navigation-runtime",
        "plan",
        manifestPath,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  };
  const plan = JSON.parse(invoke(manifest));
  expect(plan.order).toEqual(
    Array.from({ length: 5 }, (_, index) => [
      { pair: index + 1, arm: "baseline" },
      { pair: index + 1, arm: "candidate" },
    ]).flat(),
  );
  expect(plan.exclusions).toMatchObject({ totalUpdateMs: null, nativeGatewayDowntimeMs: null });
  expect(plan.bindings.map((entry: { sha256: string }) => entry.sha256)).toEqual([
    manifest.baseline.sha256,
    manifest.candidate.sha256,
  ]);
  const badSchema = pack("old-schema", metadata.openclaw.schemaVersions.agent - 1);
  for (const invalid of [
    { ...manifest, pairs: 1 },
    { ...manifest, nodeSha256: "0".repeat(64) },
    { ...manifest, fixtureProducerSha256: "0".repeat(64) },
    { ...manifest, candidate: { ...manifest.candidate, sha256: "0".repeat(64) } },
    { ...manifest, baseline: badSchema },
    { ...manifest, outputRoot: path.join(root, "outside") },
  ]) {
    fs.writeFileSync(manifestPath, JSON.stringify(invalid));
    await expect(planColdNavigationRuntime(manifestPath)).rejects.toThrow();
    expect(fs.existsSync(outputRoot)).toBe(false);
  }
  fs.mkdirSync(manifest.outputRoot);
  fs.writeFileSync(path.join(manifest.outputRoot, "owned-by-someone-else"), "keep");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await expect(planColdNavigationRuntime(manifestPath)).rejects.toThrow("already exists");
  expect(fs.readFileSync(path.join(manifest.outputRoot, "owned-by-someone-else"), "utf8")).toBe(
    "keep",
  );
});

it("rejects candidate completion without measured writes and history while work remains pending", () => {
  const traffic: ColdRuntimeObservation[] = ["write", "history"].map((kind) => ({
    requestId: kind,
    kind: kind === "write" ? "write" : "history",
    phase: "traffic",
    startMs: 5_000,
    endMs: 5_010,
    epochMs: 0,
    pending: 0,
    pendingAtEnd: 0,
  }));
  const check = (observations: ColdRuntimeObservation[], pending = 0) =>
    assertColdNavigationTrafficCoverage({ arm: "candidate", pending, observations });
  expect(() => check(traffic)).toThrow("inconclusive");
  const overlapping = traffic.map((row) => Object.assign({}, row, { pending: 3, pendingAtEnd: 2 }));
  expect(check(overlapping)).toEqual({ write: ["write"], history: ["history"] });
  expect(() => check(overlapping, 1)).toThrow("incomplete");
  expect(() => check(overlapping.map((row) => ({ ...row, phase: "warmup" })))).toThrow(
    "inconclusive",
  );
  expect(() =>
    check(
      overlapping.map((row) =>
        row.kind === "history" ? { ...row, pending: 0, pendingAtEnd: 0 } : row,
      ),
    ),
  ).toThrow("inconclusive");
  expect(() => check(overlapping.map((row) => ({ ...row, error: "timeout" })))).toThrow(
    "inconclusive",
  );
  expect(() =>
    check(overlapping.map((row) => Object.assign({}, row, { requestId: undefined }))),
  ).toThrow("inconclusive");
});
