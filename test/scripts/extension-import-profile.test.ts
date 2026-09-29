import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureImportIdentity,
  importCpuDelta,
  importIdentityGaps,
  parseImportResources,
  RESOURCE_MARKER,
} from "../../scripts/lib/extension-import-profile.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = { node: "v24.19.0", v8: "13.6", abi: "137", platform: "linux", arch: "x64" };
const observation = { pid: 42, maxRssKb: 2048, runtime };
const sample = (userCpuUs: number, systemCpuUs: number) =>
  parseImportResources(
    RESOURCE_MARKER + JSON.stringify({ ...observation, userCpuUs, systemCpuUs }),
  );

describe("cold-import resource observations", () => {
  it("reconciles signed baseline deltas without hiding negative costs", () => {
    const baseline = sample(100, 40);
    const measured = sample(90, 50);
    expect(importCpuDelta(measured, baseline)).toEqual({
      userCpuUs: -10,
      systemCpuUs: 10,
      totalCpuUs: 0,
    });
    expect(importCpuDelta(sample(80, 30), baseline)?.totalCpuUs).toBe(-30);
    expect(importCpuDelta(null, baseline)).toBeNull();
    expect(importCpuDelta(measured, null)).toBeNull();
    expect(
      importCpuDelta(measured && { ...measured, runtime: { ...runtime, arch: "arm64" } }, baseline),
    ).toBeNull();
  });

  it.each([
    "not a resource record",
    RESOURCE_MARKER + "{",
    ...[undefined, 0, -1, 1.5].map(
      (pid) =>
        RESOURCE_MARKER + JSON.stringify({ ...observation, pid, userCpuUs: 1, systemCpuUs: 0 }),
    ),
    ...[undefined, -1, 1.5].map(
      (maxRssKb) =>
        RESOURCE_MARKER +
        JSON.stringify({ ...observation, maxRssKb, userCpuUs: 1, systemCpuUs: 0 }),
    ),
    RESOURCE_MARKER + JSON.stringify({ ...observation, userCpuUs: -1, systemCpuUs: 0, runtime }),
    RESOURCE_MARKER + JSON.stringify({ ...observation, userCpuUs: 1.5, systemCpuUs: 0, runtime }),
    RESOURCE_MARKER + JSON.stringify({ ...observation, userCpuUs: 1, runtime }),
    RESOURCE_MARKER + JSON.stringify({ ...observation, userCpuUs: 1, systemCpuUs: 0, runtime: {} }),
    RESOURCE_MARKER +
      JSON.stringify({
        ...observation,
        userCpuUs: Number.MAX_SAFE_INTEGER,
        systemCpuUs: 1,
        runtime,
      }),
  ])("does not admit incomplete or invalid counters: %s", (line) => {
    expect(parseImportResources(line)).toBeNull();
  });

  it("keeps unavailable build identity and changed entry bytes visible", () => {
    const root = tempDirs.make("openclaw-import-identity-");
    const file = path.join(root, "dist/extensions/example/index.js");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export {};\n");
    const before = captureImportIdentity(root, [file]);
    expect(before.entries[0]).toMatchObject({
      path: "dist/extensions/example/index.js",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(importIdentityGaps(before, before)).toContain("canonical build identity unavailable");
    writeFileSync(file, "export const changed = true;\n");
    expect(importIdentityGaps(before, captureImportIdentity(root, [file]))).toContain(
      "source, build metadata, or entry changed during profiling",
    );
    expect(JSON.stringify(before)).not.toContain(root);
  });

  it("rejects mismatched build declarations even when entry bytes stay unchanged", () => {
    const root = tempDirs.make("openclaw-import-build-");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(
      path.join(root, "dist/build-info.json"),
      JSON.stringify({ commit: "b".repeat(40) }),
    );
    const observed = captureImportIdentity(root, []);
    const identity = {
      ...observed,
      source: { commit: "a".repeat(40), tree: "c".repeat(40), trackedClean: true },
    };
    expect(importIdentityGaps(identity, identity)).toEqual([
      "build declaration does not match source commit",
    ]);
    const changed = { ...identity, source: { ...identity.source, trackedClean: false } };
    expect(importIdentityGaps(changed, changed)).toContain(
      "source identity unavailable or tracked source dirty",
    );
  });
});
