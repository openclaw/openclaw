import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { runNodeScript } from "../helpers/run-node-script.js";

type NodeResult = Awaited<ReturnType<typeof runNodeScript>>;

export function formatShimResult(result: NodeResult) {
  return `status: ${result.status}\nerror: ${inspect(result.error)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export const TSX_SHIM_WRAPPERS = [
  "scripts/lib/plugin-npm-package-manifest.mjs",
  "scripts/e2e/kitchen-sink-rpc-walk.mjs",
] as const;

export function writeEsmPluginFixture(fixtureRoot: string) {
  const pluginRoot = path.join(fixtureRoot, "compiled-plugin");
  const files = {
    "package.json": JSON.stringify({ type: "module" }),
    "node_modules/import-only/package.json": JSON.stringify({
      type: "module",
      exports: { import: "./index.js" },
    }),
    "node_modules/import-only/index.js": 'export const value = "import-only";',
    "loader.cjs": 'module.exports = { load: () => require("./index.js") };',
    "index.js": `export { value } from "import-only";
globalThis.pluginEvaluations = (globalThis.pluginEvaluations ?? 0) + 1;
export const instance = {};
`,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(pluginRoot, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const pluginPath = path.join(pluginRoot, "index.js");
  return `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
enum Transformed { Value = "transformed" }
try {
const require = createRequire(${JSON.stringify(pathToFileURL(pluginPath).href)});
const loader = require("./loader.cjs");
const first = loader.load();
const imported = await import(${JSON.stringify(pathToFileURL(pluginPath).href)});
assert.strictEqual(loader.load(), first);
assert.strictEqual(imported.instance, first.instance);
assert.strictEqual(require("./loader.cjs"), loader);
assert.strictEqual(require(${JSON.stringify(path.resolve("packages/normalization-core/src/boolean-coercion.ts"))}).parseBoolean, parseBoolean);
console.log(JSON.stringify({ value: first.value, evaluations: globalThis.pluginEvaluations,
  transformed: Transformed.Value, sourceAlias: parseBoolean(" TRUE ") }));
} catch (error) {
  console.error(error.code + ": " + error.message);
  process.exitCode = 1;
}
`;
}

export async function withShimFixture<T>(
  wrapper:
    | (typeof TSX_SHIM_WRAPPERS)[number]
    | "scripts/run-vitest.mjs"
    | "scripts/check-changed.mjs"
    | "scripts/run-tsgo.mjs"
    | "scripts/run-oxlint.mjs"
    | "scripts/run-tsgo-core-test-shards.mjs"
    | "scripts/run-node.mjs"
    | "scripts/crabbox-wrapper.mjs",
  run: (paths: {
    checkoutRoot: string;
    fixtureRoot: string;
    implementationPath: string;
    wrapperPath: string;
    runNode: (
      args: string[],
      env: NodeJS.ProcessEnv,
      cwd: string,
      onReady?: NonNullable<Parameters<typeof runNodeScript>[3]>["onReady"],
    ) => Promise<NodeResult>;
  }) => T,
) {
  // Own a sibling of Vitest's POSIX temp namespace so unjoined writers survive its cleanup.
  const fixtureParent = process.platform === "win32" ? tmpdir() : path.dirname(tmpdir());
  const fixtureRoot = realpathSync(mkdtempSync(path.join(fixtureParent, "openclaw-tsx-cli-shim-")));
  const checkoutRoot = path.join(fixtureRoot, "checkout");
  const wrapperPath = path.join(checkoutRoot, wrapper);
  const implementationPath = wrapperPath.replace(
    /\.mjs$/u,
    wrapper === "scripts/run-vitest.mjs" ? "-child.mts" : ".mts",
  );
  const commands: Array<Promise<NodeResult>> = [];
  const outcome = (async () => {
    for (const source of [
      wrapper,
      "scripts/tsx.mjs",
      "scripts/windows-cmd-helpers.mjs",
      "scripts/lib/tsx-cli-shim.mjs",
      "scripts/lib/local-check-runtime.mts",
      "scripts/lib/tooling-dependencies.mjs",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/managed-cleanup-handoff.mts",
      "scripts/lib/vitest-resource-ownership.mts",
      "scripts/lib/vitest-worker-descriptor.mts",
      "scripts/lib/windows-taskkill.mjs",
    ]) {
      const target = path.join(checkoutRoot, source);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    writeFileSync(path.join(checkoutRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return run({
      checkoutRoot,
      fixtureRoot,
      implementationPath,
      wrapperPath,
      runNode(args, env, cwd, onReady) {
        const command = runNodeScript(args, env, 10_000, { cwd, onReady });
        commands.push(command);
        return command;
      },
    });
  })();
  const callbackError = await outcome.then(
    () => undefined,
    (error: unknown) => error,
  );
  // Callback rejection can nest cleanup markers in aggregate/cause errors.
  // Join commands, then retain inputs until every nested owner is verified.
  const results = await Promise.all(commands);
  const unjoined = [callbackError, ...results.map((result) => result.error)].find(hasUnjoinedWork);
  if (unjoined) {
    const outputPath = path.join(fixtureRoot, "command-output.log");
    writeFileSync(outputPath, results.map(formatShimResult).join("\n\n"));
    throw new Error(
      `${callbackError instanceof Error ? `${callbackError.message}\n` : ""}Child cleanup unverified; retained fixture ${fixtureRoot} and output ${outputPath}. Stop remaining writers before removing this directory.`,
      {
        cause:
          callbackError && callbackError !== unjoined
            ? new AggregateError([callbackError, unjoined])
            : unjoined,
      },
    );
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
  return await outcome;
}
