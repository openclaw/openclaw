import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../../../test-helpers/temp-dir.js";
import { classifyOtelGrpcMigrationOwnership } from "./include-migration-ownership.js";

describe("include migration ownership", () => {
  const configDir = path.resolve("/tmp/openclaw-config");
  const configPath = path.join(configDir, "openclaw.json");
  const classifyOtelOwnership = (
    includeProvenance: NonNullable<
      Parameters<typeof classifyOtelGrpcMigrationOwnership>[0]["snapshot"]["includeProvenance"]
    >,
    file = configPath,
  ) =>
    classifyOtelGrpcMigrationOwnership({
      snapshot: { path: file, includeProvenance },
      authoredConfig: { diagnostics: { otel: { protocol: "grpc" } } },
      resolvedConfig: { diagnostics: { otel: { protocol: "grpc" } } },
    });
  const include = (targetPath: string, includePath = "diagnostics") => ({
    path: [includePath],
    kind: "single" as const,
    hasSiblingOverrides: false,
    hasArrayAncestor: false,
    targetPath,
  });

  it("classifies direct config even when an unrelated include exists", () => {
    expect(
      classifyOtelOwnership([include(path.join(configDir, "agents.json5"), "agents")]),
    ).toEqual({ kind: "direct" });
  });

  describe("symlinked include targets", () => {
    const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-include-ownership-" });

    beforeAll(async () => {
      await suiteRootTracker.setup();
    });

    afterAll(async () => {
      await suiteRootTracker.cleanup();
    });

    it("requires manual repair when a config-dir symlink targets an external file", async () => {
      const home = await suiteRootTracker.make("symlink-external");
      const realConfigDir = path.join(home, ".openclaw");
      const externalDir = path.join(home, "external");
      await fs.mkdir(realConfigDir, { recursive: true });
      await fs.mkdir(externalDir, { recursive: true });
      const externalTarget = path.join(externalDir, "diagnostics.json5");
      await fs.writeFile(externalTarget, "{}\n", "utf-8");
      const linkPath = path.join(realConfigDir, "diagnostics.json5");
      await fs.symlink(externalTarget, linkPath);

      expect(
        classifyOtelOwnership([include(linkPath)], path.join(realConfigDir, "openclaw.json")),
      ).toEqual({ kind: "manual", targetPaths: [linkPath] });
    });

    it("keeps a real file beneath the config directory eligible", async () => {
      const home = await suiteRootTracker.make("internal-file");
      const realConfigDir = path.join(home, ".openclaw");
      await fs.mkdir(realConfigDir, { recursive: true });
      const targetPath = path.join(realConfigDir, "diagnostics.json5");
      await fs.writeFile(targetPath, "{}\n", "utf-8");

      expect(
        classifyOtelOwnership([include(targetPath)], path.join(realConfigDir, "openclaw.json")),
      ).toEqual({ kind: "single-include", targetPath });
    });
  });
});
