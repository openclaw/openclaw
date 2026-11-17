import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  getStandaloneRuntimeProcessOutputOptions,
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
// The transcript reader constructs SessionManagerCore to plan compaction. Host hydration layered
// on that class restores cold storage, which reaches the session controller and plugin loader.
const readerHostHydrationInputs = new Set([
  "src/agents/sessions/session-manager-hydration.ts",
  "src/config/sessions/session-transcript-hydration.ts",
  "src/config/sessions/session-cold-storage.ts",
]);
// Every private chunk is one installed file, and published updaters refuse installed trees over
// 50,000 entries. This is a tripwire for a worker re-emitting the application graph, not the
// release budget: the transcript reader emitted about 5,800 chunks when it reached cold-storage
// restoration, and the largest private graph is otherwise under 400.
const PRIVATE_CHUNK_LIMIT = 1_000;
// Plugin-owned workers are packaged by their plugin build, outside the core configs.
const codeSplitWorkers = Object.keys(standaloneRuntimeProcessBuildEntries).filter(
  (name) =>
    !name.startsWith("extensions/") && getStandaloneRuntimeProcessOutputOptions(name).codeSplitting,
);

/** Build one standalone worker exactly as packaged, without its declarations or maps. */
async function buildStandaloneRuntimeProcess(name: string) {
  const [{ build: buildRuntime }, { default: buildConfigs }] = await Promise.all([
    import("tsdown"),
    import("../../tsdown.config.ts"),
  ]);
  const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
  const selected = configs.find(
    (config) =>
      config.entry &&
      typeof config.entry === "object" &&
      !Array.isArray(config.entry) &&
      Object.hasOwn(config.entry, name),
  );
  if (!selected) {
    throw new Error(`Missing runtime build config: ${name}`);
  }
  const { bundles } = await buildRuntime({
    ...selected,
    config: false,
    outDir: fs.realpathSync(createTempDir("runtime-private-chunks-")),
    dts: false,
    sourcemap: false,
    logLevel: "silent",
  });
  return {
    chunks: bundles.flatMap((bundle) => bundle.chunks.filter((chunk) => chunk.type === "chunk")),
    dispose: async () => {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    },
  };
}

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

  const lazyWorkers = [
    ...["state/openclaw-state-lease-heartbeat.worker", "cron/store/read-only.worker"].map(
      (name) => ({
        name,
        optional: [
          "src/state/openclaw-state-db-engine.ts",
          "src/state/postgres-schema.generated/runtime.ts",
        ],
      }),
    ),
    {
      name: "process/supervisor/service-child-group-anchor",
      optional: ["src/node-host/node-worker-lineage-completion.ts"],
    },
  ];
  it.each(lazyWorkers)(
    "keeps optional handlers outside $name static imports",
    async ({ name, optional }) => {
      const { chunks, dispose } = await buildStandaloneRuntimeProcess(name);
      try {
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
        for (const source of optional) {
          const owners = chunks.filter((chunk) =>
            Object.entries(chunk.modules).some(
              ([id, module]) =>
                module.renderedLength > 0 && id.replaceAll("\\", "/").endsWith(`/${source}`),
            ),
          );
          expect(owners.length, `packaged ${source}`).toBeGreaterThan(0);
          expect(
            owners.every((chunk) => reachable.has(chunk.fileName)),
            `reachable ${source}`,
          ).toBe(true);
          expect(
            owners.filter((chunk) => eager.has(chunk.fileName)).map((chunk) => chunk.fileName),
            `${name} eagerly loads ${source}`,
          ).toEqual([]);
        }
      } finally {
        await dispose();
      }
    },
    60_000,
  );

  it.each(codeSplitWorkers)(
    "keeps %s from re-emitting the application graph as private chunks",
    async (name) => {
      const { chunks, dispose } = await buildStandaloneRuntimeProcess(name);
      try {
        expect(chunks.length).toBeLessThanOrEqual(PRIVATE_CHUNK_LIMIT);
        expect(chunks.some((chunk) => chunk.isEntry)).toBe(true);
      } finally {
        await dispose();
      }
    },
    60_000,
  );

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
      if (name === "config/sessions/session-transcript.worker") {
        expect(inputs.filter((input) => readerHostHydrationInputs.has(input))).toEqual([]);
      }
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
