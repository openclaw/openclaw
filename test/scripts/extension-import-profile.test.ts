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
const resourceLine = (overrides: Record<string, unknown>) =>
  RESOURCE_MARKER + JSON.stringify({ ...observation, userCpuUs: 1, systemCpuUs: 0, ...overrides });
const sample = (userCpuUs: number, systemCpuUs: number) =>
  parseImportResources(resourceLine({ userCpuUs, systemCpuUs }));
function identityFixture(file: string, content: string) {
  const root = tempDirs.make("openclaw-import-identity-");
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return { root, target };
}

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
    ...[undefined, 0, 1.5].map((pid) => resourceLine({ pid })),
    ...[undefined, -1, 1.5].map((maxRssKb) => resourceLine({ maxRssKb })),
    resourceLine({ userCpuUs: -1 }),
    resourceLine({ userCpuUs: 1.5 }),
    resourceLine({ systemCpuUs: undefined }),
    resourceLine({ runtime: {} }),
    resourceLine({ userCpuUs: Number.MAX_SAFE_INTEGER, systemCpuUs: 1 }),
  ])("does not admit incomplete or invalid counters: %s", (line) => {
    expect(parseImportResources(line)).toBeNull();
  });

  it("keeps unavailable build identity and changed entry bytes visible", () => {
    const { root, target } = identityFixture("dist/extensions/example/index.js", "export {};\n");
    const before = captureImportIdentity(root, [target]);
    expect(before.entries[0]).toMatchObject({
      path: "dist/extensions/example/index.js",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(importIdentityGaps(before, before)).toContain("canonical build identity unavailable");
    writeFileSync(target, "export const changed = true;\n");
    expect(importIdentityGaps(before, captureImportIdentity(root, [target]))).toContain(
      "source, build metadata, or entry changed during profiling",
    );
    expect(JSON.stringify(before)).not.toContain(root);
  });

  it("rejects mismatched build declarations even when entry bytes stay unchanged", () => {
    const { root } = identityFixture(
      "dist/build-info.json",
      JSON.stringify({ commit: "b".repeat(40) }),
    );
    const identity = captureImportIdentity(root, []);
    identity.source = { commit: "a".repeat(40), tree: "c".repeat(40), trackedClean: true };
    expect(importIdentityGaps(identity, identity)).toEqual([
      "build declaration does not match source commit",
    ]);
    identity.source.trackedClean = false;
    expect(importIdentityGaps(identity, identity)).toContain(
      "source identity unavailable or tracked source dirty",
    );
  });
});
