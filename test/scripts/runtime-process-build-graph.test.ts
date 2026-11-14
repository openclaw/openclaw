import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  sharedRuntimeProcessBuildEntries,
  standaloneRuntimeProcessBuildEntries,
} from "../../scripts/lib/runtime-process-core-build-entries.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const forbiddenInputs = [
  /^src\/gateway\/server(\.|-|\/)/u,
  /^src\/flows\//u,
  /^src\/wizard\//u,
  /^src\/agents\/tools\/in-process-gateway\.ts$/u,
  /^src\/infra\/update-run-write\.ts$/u,
  /^src\/infra\/update-failure-facts\.ts$/u,
];

describe("standalone runtime process build graph", () => {
  it("keeps small workers out of shared Gateway chunks", () => {
    const workers = [
      "infra/update-state-sizes.entry",
      "config/sessions/disk-budget.worker",
      "media/attachment-processor.worker",
      "agents/plugin-model-catalog-read.worker",
      "agents/code-mode-node.worker",
    ];
    expect(
      Object.keys(
        sharedRuntimeProcessBuildEntries({
          ...Object.fromEntries(workers.map((name) => [name, name])),
          "fixture/shared": "fixture/shared.ts",
        }),
      ),
    ).toEqual(["fixture/shared"]);
  });

  it("keeps PostgreSQL outside the built SQLite heartbeat's static imports", async () => {
    const [{ build: buildRuntime }, { default: buildConfigs }] = await Promise.all([
      import("tsdown"),
      import("../../tsdown.config.ts"),
    ]);
    const name = "state/openclaw-state-lease-heartbeat.worker";
    const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
    const selected = configs.find(
      (config) =>
        config.entry &&
        typeof config.entry === "object" &&
        !Array.isArray(config.entry) &&
        Object.hasOwn(config.entry, name),
    );
    if (!selected) {
      throw new Error("Missing heartbeat runtime build config");
    }
    const root = fs.realpathSync(createTempDir("heartbeat-private-chunks-"));
    const { bundles } = await buildRuntime({
      ...selected,
      config: false,
      outDir: root,
      dts: false,
      sourcemap: false,
      logLevel: "silent",
    });
    try {
      const chunks = bundles.flatMap((bundle) =>
        bundle.chunks.filter((chunk) => chunk.type === "chunk"),
      );
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const entry = chunks.find((chunk) => chunk.isEntry);
      expect(entry).toBeDefined();
      const closure = (includeDynamic: boolean) => {
        const reached = new Set<string>();
        const visit = (fileName: string) => {
          if (reached.has(fileName)) {
            return;
          }
          const chunk = byName.get(fileName);
          if (!chunk) {
            throw new Error(`Missing emitted chunk: ${fileName}`);
          }
          reached.add(fileName);
          const imports = includeDynamic
            ? [...chunk.imports, ...chunk.dynamicImports]
            : chunk.imports;
          for (const imported of imports) {
            if (byName.has(imported)) {
              visit(imported);
            } else if (imported.startsWith(".")) {
              visit(path.posix.join(path.posix.dirname(fileName), imported));
            }
          }
        };
        visit(entry!.fileName);
        return reached;
      };
      const eager = closure(false);
      const reachable = closure(true);
      const postgres = [
        "src/state/openclaw-state-db-engine.ts",
        "src/state/postgres-schema.generated/runtime.ts",
      ];
      for (const source of postgres) {
        const owners = chunks.filter((chunk) =>
          chunk.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(`/${source}`)),
        );
        expect(owners.length, `packaged ${source}`).toBeGreaterThan(0);
        expect(
          owners.every((chunk) => reachable.has(chunk.fileName)),
          `reachable ${source}`,
        ).toBe(true);
        expect(
          owners.filter((chunk) => eager.has(chunk.fileName)).map((chunk) => chunk.fileName),
          `SQLite eagerly loads ${source}`,
        ).toEqual([]);
      }
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  }, 60_000);

  it.each(Object.entries(standaloneRuntimeProcessBuildEntries))(
    "keeps %s out of the Gateway server graph",
    async (name, entry) => {
      const result = await build({
        absWorkingDir: repoRoot,
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        write: false,
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      expect(
        inputs.filter((input) => forbiddenInputs.some((pattern) => pattern.test(input))),
      ).toEqual([]);
      if (name === "infra/sqlite-source-revision.worker") {
        expect(
          inputs.filter((input) =>
            /^src\/(?:config\/|plugins\/|snapshot\/|infra\/(?:node-sqlite|update-database-generations)\.)/u.test(
              input,
            ),
          ),
        ).toEqual([]);
      }
    },
  );
});
