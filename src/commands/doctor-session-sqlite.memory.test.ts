import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "tsdown";
import { afterAll, beforeAll, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import {
  createRuntimeProcessBuildEntries,
  runtimeProcessCoreEntrypoints,
} from "../../scripts/lib/runtime-process-core-build-entries.mts";
import { createSqliteSchemaAssetsPlugin } from "../../scripts/lib/sqlite-schema-assets.mts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sqliteImportMemorySupportUrl } from "./doctor-session-sqlite.memory.test-support.js";

const execFileAsync = promisify(execFile);
let bundleDir: string;
let childPath: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(process.cwd(), ".artifacts"), { recursive: true });
  bundleDir = fs.mkdtempSync(path.join(process.cwd(), ".artifacts/import-memory-"));
  // Runtime workers resolve stable packaged paths beneath dist, even from a bundled caller.
  const outDir = path.join(bundleDir, "dist");
  fs.mkdirSync(outDir);
  childPath = path.join(outDir, "child.js");
  const { bundles } = await build({
    config: false,
    dts: false,
    entry: {
      child: fileURLToPath(sqliteImportMemorySupportUrl),
      ...createRuntimeProcessBuildEntries(runtimeProcessCoreEntrypoints),
    },
    format: "esm",
    // Keep generated source overhead out of the transcript-data heap budget;
    // preserve function/class names used by runtime dispatch and diagnostics.
    minify: { codegen: true, compress: true, mangle: { keepNames: true } },
    // Preserve lazy imports so unrelated runtime modules do not consume the child heap.
    outputOptions: { codeSplitting: true },
    outDir,
    outExtensions: () => ({ js: ".js" }),
    deps: {
      alwaysBundle: (id) =>
        Object.entries(packageJson.dependencies).some(
          ([name, version]) =>
            version.startsWith("workspace:") && (id === name || id.startsWith(`${name}/`)),
        ),
      neverBundle: Object.entries(packageJson.dependencies)
        .filter(([, version]) => !version.startsWith("workspace:"))
        .map(([name]) => name),
    },
    plugins: [createStateSchemaInlinePlugin(), createSqliteSchemaAssetsPlugin()],
    platform: "node",
    target: "node22",
    logLevel: "error",
  });
  for (const bundle of bundles) {
    await bundle[Symbol.asyncDispose]();
  }
});
afterAll(() => {
  if (bundleDir) {
    fs.rmSync(bundleDir, { force: true, recursive: true });
  }
});

it.each(["batch", "public"])(
  "imports %s transcripts and completes branch projections under a 256 MiB heap",
  async (scenario) => {
    await withOpenClawTestState({ applyEnv: false, label: "import-memory" }, async (state) => {
      const { stdout } = await execFileAsync(
        resolveTestNodeExecPath(),
        ["--max-old-space-size=256", childPath, state.stateDir, scenario],
        {
          cwd: process.cwd(),
          env: state.env,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 180_000,
        },
      );
      expect(JSON.parse(stdout)).toMatchObject({ scenario });
      console.info(stdout.trim());
    });
  },
  180_000,
);
