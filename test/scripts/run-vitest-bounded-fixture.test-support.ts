import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { prepareCopiedSourceModules } from "./copied-source-modules.test-support.js";
import { createPreparedWorkerCompiler } from "./vitest-worker-artifacts.prepared.test-support.js";

export function createPreparedVitestCliFixture(
  repoRoot: string,
  scripts: string[],
  {
    prepareWorkerArtifacts = false,
    preserveSourceModuleExports = false,
  }: { prepareWorkerArtifacts?: boolean; preserveSourceModuleExports?: boolean } = {},
) {
  const lifetime = createFixtureLifetime();
  const compiler = prepareWorkerArtifacts ? createPreparedWorkerCompiler() : undefined;
  let root: string;
  let redirect: string;
  return {
    get root() {
      return root;
    },
    env(base: NodeJS.ProcessEnv) {
      if (!compiler) {
        return base;
      }
      return compiler.env(
        {
          ...base,
          NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --import=${pathToFileURL(redirect).href}`,
        },
        "node",
      );
    },
    async prepare() {
      await compiler?.prepare();
      root = lifetime.createTempDir("oc-vt-prepared-cli-");
      const entries = [
        ...new Set(scripts.filter((script) => script.endsWith(".mts"))),
        "run-vitest-child.mts",
        "lib/vitest-report-capture.mts",
      ].map((script) => `scripts/${script}`);
      // Report merging selects these module URLs from generated configuration text.
      entries.push("test/vitest/vitest.reporters.ts", "test/vitest/redacting-reporter.ts");
      const closure = collectRuntimeImportClosure(
        repoRoot,
        [...entries, "scripts/run-vitest.mjs", "scripts/tsx.mjs"],
        { includeDynamicImports: true },
      );
      const files = new Set([
        ...closure,
        "scripts/lib/vitest-worker-bootstrap.mts",
        "scripts/lib/vitest-worker-compiler.mts",
        "package.json",
        "pnpm-workspace.yaml",
        "tsconfig.json",
      ]);
      for (const file of files) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), target);
      }
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      // Source URL adapters must also serve exports used by unchanged native wrappers.
      await prepareCopiedSourceModules(
        root,
        preserveSourceModuleExports
          ? closure.filter((source) => /\.[cm]?ts$/u.test(source))
          : entries,
      );
      // CLI wrappers and generated configs retain their original entry paths.
      for (const source of entries) {
        fs.copyFileSync(
          path.join(root, source.replace(/\.[cm]?ts$/u, ".js")),
          path.join(root, source),
        );
      }
      if (compiler) {
        redirect = path.join(root, "prepared-compiler.mjs");
        fs.writeFileSync(
          redirect,
          `import {registerHooks} from "node:module";
const copied = ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/vitest-worker-compiler.mts")).href)};
const original = ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/vitest-worker-compiler.mts")).href)};
registerHooks({resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url === copied ? {...resolved, url: original} : resolved;
}});
`,
        );
      }
    },
    async cleanup() {
      try {
        await compiler?.cleanup();
      } finally {
        await lifetime.cleanup();
      }
    },
  };
}
