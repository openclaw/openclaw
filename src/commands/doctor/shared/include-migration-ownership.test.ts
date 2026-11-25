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

  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-include-ownership-" });

  beforeAll(() => suiteRootTracker.setup());
  afterAll(() => suiteRootTracker.cleanup());

  it.each([
    { name: "external symlink requires manual repair", external: true },
    { name: "internal file is eligible for automatic repair", external: false },
  ])("$name", async ({ external }) => {
    const home = await suiteRootTracker.make(external ? "symlink-external" : "internal-file");
    const realConfigDir = path.join(home, ".openclaw");
    await fs.mkdir(realConfigDir, { recursive: true });
    const targetPath = path.join(realConfigDir, "diagnostics.json5");
    if (external) {
      const externalDir = path.join(home, "external");
      await fs.mkdir(externalDir, { recursive: true });
      const externalTarget = path.join(externalDir, "diagnostics.json5");
      await fs.writeFile(externalTarget, "{}\n", "utf-8");
      await fs.symlink(externalTarget, targetPath);
    } else {
      await fs.writeFile(targetPath, "{}\n", "utf-8");
    }

    expect(
      classifyOtelOwnership([include(targetPath)], path.join(realConfigDir, "openclaw.json")),
    ).toEqual(
      external
        ? { kind: "manual", targetPaths: [targetPath] }
        : { kind: "single-include", targetPath },
    );
  });
});
