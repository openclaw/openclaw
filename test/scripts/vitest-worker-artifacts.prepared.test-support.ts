import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { verifyVitestWorkerArtifacts } from "../../scripts/lib/vitest-worker-artifacts.mts";
import { formatErrorMessage } from "../../src/infra/errors.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { fixturePreloadEnv } from "./fixtures/ci-fixture-runtime.cjs";
import { writeFixture } from "./vitest-worker-artifacts.test-support.js";

/** One real application build; borrowers still own independent, disposable generations. */
export function createPreparedWorkerCompiler() {
  const root = process.cwd();
  const lifetime = createFixtureLifetime();
  let preload: string;
  let template: string;
  let receipt: string;
  const compiler = path.join(root, "scripts/lib/vitest-worker-compiler.mts");
  const tsdown = pathToFileURL(createRequire(import.meta.url).resolve("tsdown")).href;

  function env(base: NodeJS.ProcessEnv, runtime: "node" | "bun") {
    return {
      ...base,
      ...Object.fromEntries(
        Object.entries(fixturePreloadEnv(preload, runtime)).map(([key, value]) => [
          key,
          `${base[key] ?? ""} ${value}`.trim(),
        ]),
      ),
    };
  }

  function readCompiles(): Array<{ kind: "full" | "copy"; directory: string }> {
    return fs
      .readFileSync(receipt, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  return {
    env,
    async prepare() {
      const parent = path.join(root, ".artifacts/vitest-workers");
      fs.mkdirSync(parent, { recursive: true });
      template = lifetime.createTempDir("run-", parent);
      fs.writeFileSync(path.join(template, "package.json"), '{"type":"module"}\n');
      const fixtures = lifetime.createTempDir("prepared-compiler-", path.join(root, ".artifacts"));
      receipt = path.join(fixtures, "compiles.jsonl");
      const clone = fileURLToPath(
        new URL("./fixtures/vitest-worker-prepared.mjs", import.meta.url),
      );
      preload = writeFixture(
        fixtures,
        "preload.mjs",
        `import fs from 'node:fs';
import {registerHooks} from 'node:module';
const compiler = ${JSON.stringify(pathToFileURL(compiler).href)};
const buildEntries = ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/vitest-worker-build-entries.mts")).href)};
registerHooks({load(url,context,nextLoad) {
  const narrow = globalThis[Symbol.for('openclaw.fixture.realCompiler')];
  // These tests inspect only the declaration in the unbundled legacy graph.
  // The CLI finalizer fixture owns the unbundled updater execution proof.
  if(url===buildEntries && process.argv[1]===${JSON.stringify(compiler)} && process.argv[2]===${JSON.stringify(template)}) {
    const original=JSON.stringify(buildEntries+'?fixture-original');
    return {format:'module',shortCircuit:true,source:
      'export * from '+original+';import * as original from '+original+';'+
      'export const preservedModuleBuildSources=original.preservedModuleBuildSources.filter(source=>source==="src/infra/runtime-process-entrypoints.ts"||source==="scripts/run-with-env.mts");'};
  }
  if(url===${JSON.stringify(tsdown)} && process.argv[1]===${JSON.stringify(compiler)} && !narrow) {
    fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({kind:'full',directory:process.argv[2]})+'\\n');
  }
  if(url!==compiler) return nextLoad(url,context);
  const full = process.argv[2] === ${JSON.stringify(template)};
  if(full || narrow) return nextLoad(url,context);
  fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({kind:'copy',directory:process.argv[2]})+'\\n');
  return {format:'module',shortCircuit:true,source:
    'import {copyPreparedWorkerArtifacts} from '+JSON.stringify(${JSON.stringify(pathToFileURL(clone).href)})+';'+
    'await copyPreparedWorkerArtifacts('+JSON.stringify(${JSON.stringify(template)})+',process.argv[2]);'};
}});`,
      );
      const result = await lifetime.track(
        runNodeScript(
          [compiler, template],
          env(process.env, "node"),
          DEFAULT_VITEST_TEST_TIMEOUT_MS,
          {
            cwd: root,
            requireProcessTreeExit: process.platform !== "win32",
            maxBuffer: 2 * 1024 * 1024,
          },
        ),
      );
      const preparationError = result.error === undefined ? "" : formatErrorMessage(result.error);
      expect(
        result.status,
        [preparationError, result.stderr, result.stdout].filter(Boolean).join("\n"),
      ).toBe(0);
      await verifyVitestWorkerArtifacts(template);
      const manifest = JSON.parse(fs.readFileSync(path.join(template, "manifest.json"), "utf8"));
      console.log(`file compiler prepared in ${Math.round(manifest.durationMs)}ms`);
    },
    readCompiles,
    async cleanup() {
      try {
        if (template && fs.existsSync(path.join(template, "manifest.json"))) {
          await verifyVitestWorkerArtifacts(template);
          expect(readCompiles().filter(({ kind }) => kind === "full")).toHaveLength(1);
        }
      } finally {
        await lifetime.cleanup();
      }
    },
  };
}

export function interceptCompilerBuild(directory: string, source: string): string {
  const root = process.cwd();
  const compilerModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsdown")).href;
  // Compiler lifetime faults need real phases and sealing, not the entire application graph.
  const fixtureModules = {
    "scripts/lib/vitest-worker-build-entries.mts": `
export const vitestWorkerBuildEntries = {
  "infra/sqlite-readonly-location.worker": original.vitestWorkerBuildEntries["infra/sqlite-readonly-location.worker"],
};
export const preservedModuleBuildSources = original.preservedModuleBuildSources.filter(
  source => source === "src/infra/runtime-process-entrypoints.ts",
);
`,
    "scripts/lib/vitest-worker-declarations.mts": `
export const vitestWorkerDeclarationEntries = {
  "infra/runtime-process-entrypoints": original.vitestWorkerDeclarationEntries["infra/runtime-process-entrypoints"],
};
`,
  };
  const replacements = Object.fromEntries(
    Object.entries(fixtureModules).map(([filename, contents]) => {
      const canonical = pathToFileURL(path.join(root, filename)).href;
      // Bypass this exact-URL replacement while retaining the owner's complete namespace.
      const original = JSON.stringify(`${canonical}?fixture-original`);
      const fixture = writeFixture(
        directory,
        `${path.basename(filename, ".mts")}.mjs`,
        `export * from ${original};\nimport * as original from ${original};\n${contents}`,
      );
      return [canonical, pathToFileURL(fixture).href];
    }),
  );
  // Sync require hooks still use the CJS filesystem loader; a resolve-only data URL is not loadable.
  const wrapper = writeFixture(
    directory,
    "tsdown-wrapper.mjs",
    `import * as compiler from ${JSON.stringify(compilerModuleUrl)};\nconst compile = compiler.build;\n${source}`,
  );
  return `import {registerHooks} from 'node:module';
globalThis[Symbol.for('openclaw.fixture.realCompiler')]=true;
const replacements=${JSON.stringify(replacements)};
registerHooks({resolve(specifier,context,nextResolve) {
  if(specifier==='tsdown') return {url:${JSON.stringify(pathToFileURL(wrapper).href)},format:'module',shortCircuit:true};
  const resolved=nextResolve(specifier,context);
  const replacement=replacements[resolved.url];
  return replacement ? {...resolved,url:replacement,format:'module',shortCircuit:true} : resolved;
}});`;
}
