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
  ) =>
    classifyOtelGrpcMigrationOwnership({
      snapshot: { path: configPath, includeProvenance },
      authoredConfig: { diagnostics: { otel: { protocol: "grpc" } } },
      resolvedConfig: { diagnostics: { otel: { protocol: "grpc" } } },
    });

  it("classifies direct config even when an unrelated include exists", () => {
    expect(
      classifyOtelOwnership([
        {
          path: ["agents"],
          kind: "single",
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPath: path.join(configDir, "agents.json5"),
        },
      ]),
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
        classifyOtelGrpcMigrationOwnership({
          snapshot: {
            path: path.join(realConfigDir, "openclaw.json"),
            includeProvenance: [
              {
                path: ["diagnostics"],
                kind: "single",
                hasSiblingOverrides: false,
                hasArrayAncestor: false,
                targetPath: linkPath,
              },
            ],
          },
          authoredConfig: { diagnostics: { otel: { protocol: "grpc" } } },
          resolvedConfig: { diagnostics: { otel: { protocol: "grpc" } } },
        }),
      ).toEqual({ kind: "manual", targetPaths: [linkPath] });
    });

    it("keeps a real file beneath the config directory eligible", async () => {
      const home = await suiteRootTracker.make("internal-file");
      const realConfigDir = path.join(home, ".openclaw");
      await fs.mkdir(realConfigDir, { recursive: true });
      const targetPath = path.join(realConfigDir, "diagnostics.json5");
      await fs.writeFile(targetPath, "{}\n", "utf-8");

      expect(
        classifyOtelGrpcMigrationOwnership({
          snapshot: {
            path: path.join(realConfigDir, "openclaw.json"),
            includeProvenance: [
              {
                path: ["diagnostics"],
                kind: "single",
                hasSiblingOverrides: false,
                hasArrayAncestor: false,
                targetPath,
              },
            ],
          },
          authoredConfig: { diagnostics: { otel: { protocol: "grpc" } } },
          resolvedConfig: { diagnostics: { otel: { protocol: "grpc" } } },
        }),
      ).toEqual({ kind: "single-include", targetPath });
    });
  });
});
