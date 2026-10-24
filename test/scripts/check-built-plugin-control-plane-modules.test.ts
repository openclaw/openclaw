import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectBuiltDoctorContractClosureViolations,
  listBuiltPluginControlPlaneModules,
  probeBuiltPluginControlPlaneModules,
  verifyBuiltPluginControlPlaneModules,
} from "../../scripts/check-built-plugin-control-plane-modules.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

const roots = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

function makeRoot(extension = ".js", modules: Record<string, string> = {}): string {
  const rootDir = roots.make("openclaw-plugin-control-plane-");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}\n');
  if (extension === ".cjs") {
    write(rootDir, "extensions/demo/openclaw.plugin.json", '{"id":"demo"}');
    write(rootDir, "extensions/demo/index.ts", "export {};\n");
    write(
      rootDir,
      "extensions/demo/package.json",
      '{"openclaw":{"extensions":["./index.ts"],"build":{"bundledDist":false,"runtimeFormat":"cjs"},"release":{"publishToNpm":true}}}',
    );
  }
  for (const [name, source] of Object.entries(modules)) {
    write(rootDir, `dist/extensions/demo/${name}${extension}`, source);
  }
  return rootDir;
}

function write(rootDir: string, relativePath: string, source: string): void {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function moduleInfo(pluginId: string, kind: string, filename: string) {
  return { pluginId, kind, relativePath: `dist/extensions/${pluginId}/${filename}` };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("built plugin control-plane module loads", () => {
  it("keeps the native compiler unstarted for checker imports and runtime inventory checks", () => {
    const rootDir = makeRoot();
    const checkerUrl = resolveRuntimeWorkerUrl(toolingMtsEntrypoints.controlPlane);
    const result = spawnSync(
      testNodeExecPath,
      [
        ...resolveRuntimeWorkerArgv(checkerUrl, testNodeExecPath).slice(0, -1),
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
let compilerStarts = 0;
childProcess.spawn = function(executable, args, ...rest) {
  if (args?.includes("--api")) compilerStarts++;
  return Reflect.apply(spawn, this, [executable, args, ...rest]);
};
syncBuiltinESMExports();
assert.equal(compilerStarts, 0, "native compiler started before the checker");
await import(${JSON.stringify(checkerUrl.href)});
assert.equal(compilerStarts, 0, "native compiler started by the checker import");
const { listCoreRuntimePostBuildOutputs } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(toolingMtsEntrypoints.runtimePostbuild).href)});
listCoreRuntimePostBuildOutputs({ rootDir: ${JSON.stringify(rootDir)} });
assert.equal(compilerStarts, 0, "native compiler started by runtime postbuild inventory checks");
await import(${JSON.stringify(resolveRuntimeWorkerUrl(toolingMtsEntrypoints.runNode).href)});
assert.equal(compilerStarts, 0, "native compiler started by the development runner import");
const { API } = await import("typescript/sync");
const api = new API();
try {
  api.parseConfigFile("tsconfig.json");
  assert.equal(compilerStarts, 1, "the compiler process observation must detect an actual start");
} finally {
  api.close();
}
`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: undefined },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("lists exact .cjs contracts and channel legacy setup references", () => {
    const rootDir = makeRoot(".cjs", {
      "doctor-contract-api": "export const ok = true;\n",
      "contract-api": "export const ok = true;\n",
      "provider-contract-api": "export const ignored = true;\n",
      "setup-entry":
        'const setup = {\n  legacyStateMigrations: { specifier: "./legacy-state-migrations-api.cjs" },\n  legacySessionSurface: { specifier: "./legacy-session-surface-api.cjs" },\n};\nexport default setup;',
      "legacy-state-migrations-api": "export {};\n",
      "legacy-session-surface-api": "export {};\n",
    });

    expect(listBuiltPluginControlPlaneModules({ rootDir })).toEqual([
      moduleInfo("demo", "contract", "contract-api.cjs"),
      moduleInfo("demo", "doctor-contract", "doctor-contract-api.cjs"),
      moduleInfo("demo", "channel-legacy-session-surface", "legacy-session-surface-api.cjs"),
      moduleInfo("demo", "channel-legacy-state-migrations", "legacy-state-migrations-api.cjs"),
    ]);
  });

  it("accepts synchronously requireable .cjs artifacts", () => {
    const rootDir = makeRoot(".cjs", { "doctor-contract-api": "exports.ok = true;\n" });

    expect(() => verifyBuiltPluginControlPlaneModules({ rootDir })).not.toThrow();
  });

  it("reports plugin, kind, path, and native require error", () => {
    const rootDir = makeRoot(".js", {
      "doctor-contract-api": "await Promise.resolve();\nexport const ok = true;\n",
    });

    expect(() => verifyBuiltPluginControlPlaneModules({ rootDir })).toThrow(
      /demo \(doctor-contract\) dist\/extensions\/demo\/doctor-contract-api\.js:.*ERR_REQUIRE_ASYNC_MODULE/s,
    );
  });

  it("bounds a stalled native require child", () => {
    const rootDir = makeRoot(".js", { "doctor-contract-api": "while (true) {}\n" });
    const modules = listBuiltPluginControlPlaneModules({ rootDir });

    expect(() => probeBuiltPluginControlPlaneModules(modules, { rootDir, timeoutMs: 100 })).toThrow(
      /timed out|ETIMEDOUT/u,
    );
  });
  it.each([".js", ".cjs"])(
    "checks shared and cyclic %s chunks once while reporting each doctor contract",
    (extension) => {
      const rootDir = makeRoot(extension);
      const edge = (target: string) =>
        extension === ".cjs"
          ? `module.exports = require("${target}${extension}");`
          : `export * from "${target}${extension}";`;
      const modules = ["demo", "other"].map((pluginId) =>
        moduleInfo(pluginId, "doctor-contract", `doctor-contract-api${extension}`),
      );
      for (const module of modules) {
        write(rootDir, module.relativePath, edge("../../token-chunk"));
      }
      write(rootDir, `dist/token-chunk${extension}`, edge("./exec-chunk"));
      write(
        rootDir,
        `dist/exec-chunk${extension}`,
        extension === ".cjs"
          ? 'require("./token-chunk.cjs"); const exec = require("execa"); exports.rule = exec;'
          : 'import "./token-chunk.js"; import "execa"; export const rule = 1;',
      );
      const readFile = vi.spyOn(fs, "readFileSync");
      expect(collectBuiltDoctorContractClosureViolations(modules, { rootDir })).toEqual(
        modules.map((module) => ({
          ...module,
          dependency: "execa",
          importerPath: `dist/exec-chunk${extension}`,
        })),
      );
      for (const chunk of ["token-chunk", "exec-chunk"]) {
        expect(
          readFile.mock.calls.filter(
            ([file]) => file === path.join(rootDir, `dist/${chunk}${extension}`),
          ),
        ).toHaveLength(1);
      }
      write(rootDir, `dist/exec-chunk${extension}`, "");
      expect(collectBuiltDoctorContractClosureViolations(modules, { rootDir })).toEqual([]);
    },
  );

  it("ignores lazy .cjs edges and non-doctor contract surfaces", () => {
    // A function-local require is never paid at enumeration time, and the general contract
    // surface may legitimately spawn commands (matrix probes its SDK packages).
    const rootDir = makeRoot(".cjs", {
      "doctor-contract-api": 'exports.load = () => require("execa");',
      "contract-api": 'require("execa"); exports.a = 1;',
    });

    expect(
      collectBuiltDoctorContractClosureViolations(listBuiltPluginControlPlaneModules({ rootDir }), {
        rootDir,
      }),
    ).toEqual([]);
  });
});
