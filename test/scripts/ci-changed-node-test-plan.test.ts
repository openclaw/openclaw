import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mjs";

describe("CI changed Node test plan", () => {
  it("routes a focused source change into one targeted job", () => {
    expect(createChangedNodeTestShards(["src/utils/chunk-items.ts"])).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: [
          "src/utils/chunk-items.test.ts",
          "src/plugin-sdk/text-chunking.test.ts",
          "src/utils/utils-misc.test.ts",
        ],
      },
    ]);
  });

  it("routes built-artifact boundary tests through the dist gate", () => {
    expect(createChangedNodeTestShards(["test/extension-import-boundaries.test.ts"])).toEqual([
      {
        checkName: "checks-node-changed-dist",
        configs: ["test/vitest/vitest.boundary.config.ts"],
        requiresDist: true,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-dist",
        targets: ["test/extension-import-boundaries.test.ts"],
      },
    ]);
  });

  it("fails safe to the full plan for broad or deleted changes", () => {
    expect(createChangedNodeTestShards(["package.json"])).toBeNull();
    expect(createChangedNodeTestShards(["src/removed-module.ts"])).toBeNull();
  });

  it("fails safe when public SDK changes affect extension imports", () => {
    expect(createChangedNodeTestShards(["src/plugin-sdk/index.ts"])).toBeNull();
  });

  it("fails safe when workspace package consumers use package imports", () => {
    expect(
      createChangedNodeTestShards(["packages/gateway-protocol/src/frame-guards.ts"]),
    ).toBeNull();
  });

  it("fails safe when a targeted config needs special shard setup", () => {
    expect(createChangedNodeTestShards(["scripts/docs-i18n/main.go"])).toBeNull();
    expect(createChangedNodeTestShards(["src/tui/tui-pty-harness.e2e.test.ts"])).toBeNull();
  });

  it("fails safe when a source target has no matching test", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-target-"));
    try {
      writeFileSync(path.join(cwd, "value.ts"), "export const value = 1;\n");
      expect(createChangedNodeTestShards(["value.ts"], { cwd })).toBeNull();
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails safe for aggregate full-suite configs", () => {
    expect(
      createChangedNodeTestShards(["test/vitest/vitest.full-core-support-boundary.config.ts"]),
    ).toBeNull();
  });

  it("fails safe for leaf configs split across full-suite processes", () => {
    expect(createChangedNodeTestShards(["test/vitest/vitest.commands.config.ts"])).toBeNull();
  });

  it("fails safe when source targets expand to a whole config", () => {
    expect(
      createChangedNodeTestShards(["ui/src/app-routes.ts", "ui/src/app-navigation.ts"]),
    ).toBeNull();
  });
});
