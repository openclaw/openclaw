import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import { createPreparedVitestCliFixture } from "./run-vitest-bounded-fixture.test-support.js";
import { cleanRunnerEnv, repoRoot, scriptFiles } from "./run-vitest.test-support.js";

const posixDescribe = process.platform === "win32" ? describe.skip : describe;
const testNodeExecPath = resolveTestNodeExecPath();

function fixtureEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return cleanRunnerEnv({ CI: "1", ...overrides });
}

function runSync(args: string[], env: NodeJS.ProcessEnv, timeout = 15_000) {
  return spawnSync(testNodeExecPath, args, { cwd: repoRoot, env, encoding: "utf8", timeout });
}

const preparedCli = createPreparedVitestCliFixture(repoRoot, ["run-vitest.mjs"], {
  prepareWorkerArtifacts: true,
});
beforeAll(() => preparedCli.prepare());
afterAll(() => preparedCli.cleanup());

const packageScripts = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  .scripts as Record<string, string>;
const loaderEntries = [
  {
    name: "JavaScript launcher",
    args: [path.join(repoRoot, "scripts/run-vitest.mjs")],
  },
  ...["test", "test:extensions:batch"].map((name) => ({
    name,
    args: packageScripts[name]!.split(" ").slice(1),
  })),
];

describe("Vitest CLI final outcome ownership", () => {
  it.for(
    ["missing", "broken"].flatMap((failure) =>
      loaderEntries.map(({ name, args }) => ({
        name,
        args,
        failure,
        code: 2,
        failedTrailers: name === "test:extensions:batch" ? [] : ["[test] FAILED (exit 2)"],
      })),
    ),
  )(
    "classifies $failure exit $code at $name",
    ({ failure, args, failedTrailers, code }, context) => {
      const lifetime = createFixtureLifetime();
      context.onTestFinished(() => lifetime.cleanup());
      return lifetime.run(async () => {
        const files = scriptFiles(lifetime.createTempDir("oc-vt-loader-"));
        const injection =
          failure === "missing"
            ? 'throw Object.assign(new Error("owned missing loader dependency"), {code: "ERR_MODULE_NOT_FOUND"});'
            : `return {format: "module", shortCircuit: true, source: ${JSON.stringify('throw new Error("owned broken loader dependency");')}};`;
        files.write(
          "preload.mjs",
          `import {registerHooks} from "node:module";
registerHooks({load(url, context, nextLoad) {
  if (url.endsWith("/scripts/tsx.mjs")) {
    ${injection}
  }
  return nextLoad(url, context);
}});`,
        );
        const result = await lifetime.track(
          runNodeScript(
            [...args, "--help"],
            {
              ...testRunnerFixtureEnv(),
              NODE_OPTIONS: `--import=${files.path("preload.mjs")}`,
            },
            10_000,
            {
              signal: context.signal,
              requireProcessTreeExit: process.platform !== "win32",
            },
          ),
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(code);
        expect(result.stderr).toContain(`owned ${failure} loader dependency`);
        expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu) ?? []).toEqual(
          failedTrailers,
        );
      });
    },
  );
});

posixDescribe("bounded Vitest process ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["mjs", "mts"])(
    "loads the native UI asset inspector before direct %s readers",
    (extension) => {
      const root = tempDirs.make("oc-vt-ui-admission-");
      const preload = path.join(root, "preload.mjs");
      const metadataPath = path.join(repoRoot, "dist/build-info.json");
      fs.writeFileSync(
        preload,
        `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  if (args.includes("scripts/prepare-vitest-runtime.mjs")) {
    return spawn(process.execPath, ["-e", ""], {
      ...options, env: { ...options.env, NODE_OPTIONS: "" },
    });
  }
  if (args.includes("scripts/ui.js") ||
      args.some(arg => arg === "vitest" || arg.endsWith("/vitest.mjs"))) {
    throw new Error("fixture reader or UI build admitted before runtime identity");
  }
  return spawn(bin, args, options);
};
const existsSync = fs.existsSync;
fs.existsSync = file => file === ${JSON.stringify(metadataPath)} || existsSync(file);
const readFileSync = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(metadataPath)}) {
    throw new Error("fixture runtime identity inspected");
  }
  return readFileSync(file, ...args);
};
syncBuiltinESMExports();
`,
      );
      const result = runSync(
        [
          path.join(repoRoot, `scripts/run-vitest.${extension}`),
          "run",
          "--config",
          "test/vitest/vitest.ui-e2e.config.ts",
          "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
        ],
        // This preload replaces only I/O; it does not install a TypeScript loader.
        fixtureEnv({ NODE_OPTIONS: `--import=${preload}` }),
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result, result.stderr).toMatchObject({ signal: null, status: 2 });
      expect(result.stderr).toContain("fixture runtime identity inspected");
      expect(result.stderr).not.toContain("fixture reader or UI build admitted");
    },
  );

  it.each(["test-failure", "cancel"])(
    "joins fresh children and preserves %s",
    { timeout: 60_000 },
    (outcome) => {
      const root = tempDirs.make("oc-vt-bounded-");
      const files = scriptFiles(root);
      files.linkModules();
      const configPath = path.join(root, "test/vitest/vitest.e2e.config.ts");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const receiptPath = path.join(root, "executed.jsonl");
      files.write(
        "test/vitest/vitest.e2e.config.ts",
        `export default {
  root: ${JSON.stringify(root)},
  test: {
    include: ["case-*.test.ts"], pool: "threads", isolate: false, maxWorkers: 1,
    env: { FIXTURE_SHARD: process.argv.find(arg => arg.startsWith("--shard=")) ?? "unsharded" },
  },
};`,
      );
      for (let index = 0; index < 4; index++) {
        files.write(
          `case-${index}.test.ts`,
          `import fs from "node:fs";
import { expect, it } from "vitest";
it("case ${index}", () => {
  fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ index: ${index}, pid: process.pid }) + "\\n");
  ${outcome === "cancel" ? 'process.kill(process.pid, "SIGTERM");' : 'expect(process.env.FIXTURE_SHARD).not.toBe("--shard=1/4");'}
});`,
        );
      }
      const result = runSync(
        [path.join(preparedCli.root, "scripts/run-vitest.mjs"), "run", "--config", configPath],
        preparedCli.env(fixtureEnv({ NO_COLOR: "1", FORCE_COLOR: "0" })),
        45_000,
      );
      expect(result.error, result.stderr).toBeUndefined();
      const trailer = `[test] FAILED (exit ${outcome === "cancel" ? 143 : 1})`;
      expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
      expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
      const receipts: Array<{ index: number; pid: number }> = files.jsonLines("executed.jsonl");
      if (outcome === "cancel") {
        expect(result.signal === "SIGTERM" || result.status === 143, result.stderr).toBe(true);
        expect(receipts).toHaveLength(1);
      } else {
        // The first shard fails, later shards pass: success must not erase that failure.
        expect(result.status, result.stderr).toBe(1);
        expect(receipts.map(({ index }) => index).toSorted((left, right) => left - right)).toEqual([
          0, 1, 2, 3,
        ]);
        expect(new Set(receipts.map(({ pid }) => pid)).size).toBe(4);
      }
      for (const { pid } of receipts) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    },
  );
});
