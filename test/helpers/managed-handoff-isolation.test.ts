import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveServiceManagerEnv } from "../../src/daemon/service-process-env.js";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "./managed-handoff-isolation.js";
import { requireNodeTool } from "./node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const require = createRequire(import.meta.url);
const tsxUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
const leaseUrl = new URL("../../src/infra/update-managed-service-handoff-lease.ts", import.meta.url)
  .href;
const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = temporary.make("openclaw-handoff-binding-");
  const binding = createManagedHandoffTestBinding(root);
  const program = path.join(root, "consumer.mjs");
  fs.writeFileSync(
    program,
    [
      'import assert from "node:assert/strict";',
      `import { register } from ${JSON.stringify(tsxUrl)};`,
      `register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });`,
      `const { resolveManagedUpdateLeaseDatabasePath, createManagedHandoffLeaseStore } = await import(${JSON.stringify(leaseUrl)});`,
      `const databasePath = resolveManagedUpdateLeaseDatabasePath();`,
      `assert.equal(databasePath, ${JSON.stringify(binding.databasePath)});`,
      `const store = createManagedHandoffLeaseStore();`,
      `const installation = ${JSON.stringify(path.join(root, "installation"))};`,
      'const acquired = store.acquire(installation, "binding-owner", { kind: "update" });',
      'assert.equal(acquired.kind, "acquired");',
      "let observed;",
      "try { observed = store.read(installation); } finally { assert.equal(store.release(acquired.lease), true); }",
      "const result = store.read(installation);",
      "process.stdout.write(JSON.stringify({ databasePath, observed, result, nodeOptions: process.env.NODE_OPTIONS ?? null }));",
    ].join("\n"),
  );
  return {
    root,
    binding,
    program,
    run: (env: NodeJS.ProcessEnv = resolveServiceManagerEnv()) => {
      const child = spawnSync(requireNodeTool("node"), [binding.nodeOption, program], {
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(child.error).toBeUndefined();
      return child;
    },
  };
}

describe("explicit managed handoff test binding", () => {
  it.each(["consumer", "preload"])("credits only target consumer resolution (%s)", (phase) => {
    const { root, binding, program, run } = fixture();
    const env: NodeJS.ProcessEnv = { ...resolveServiceManagerEnv() };
    if (phase === "consumer") {
      Object.assign(env, { HOME: root, USERPROFILE: root });
      delete env.NODE_OPTIONS;
    } else {
      fs.writeFileSync(program, 'process.stdout.write("entrypoint-ran");');
    }
    const child = run(env);
    expect(child.status, child.stderr).toBe(0);
    if (phase === "consumer") {
      const result = JSON.parse(child.stdout);
      expect(result).toMatchObject({
        databasePath: binding.databasePath,
        observed: { kind: "current", lease: { owner: "binding-owner" } },
        result: { kind: "absent" },
        nodeOptions: null,
      });
      expect(fs.statSync(binding.databasePath).isFile()).toBe(true);
      expect(binding.assertPath(result.databasePath)).toBe(binding.databasePath);
      assertManagedHandoffTestConsumer(binding, child.pid, path.resolve("src"));
    } else {
      expect(child.stdout).toBe("entrypoint-ran");
      expect(fs.readdirSync(root).some((name) => name.startsWith("preflight-"))).toBe(true);
      expect(() =>
        assertManagedHandoffTestConsumer(binding, child.pid, path.resolve("test")),
      ).toThrow(/No bound handoff resolver witness/);
      expect(fs.existsSync(binding.databasePath)).toBe(false);
    }
  });

  it("admits a second worker while another is publishing its resolver shim", () => {
    const { root, binding, program } = fixture();
    const workerPath = path.join(root, "paused-consumer.mjs");
    fs.writeFileSync(
      workerPath,
      `import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
const write = fs.writeFileSync;
let paused = false;
fs.writeFileSync = (file, source, options) => {
  if (workerData.pause && !paused && String(file).includes("fs-safe-temp-")) {
    paused = true;
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      parentPort.postMessage("publishing");
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      return write(fd, source);
    } finally {
      fs.closeSync(fd);
    }
  }
  return write(file, source, options);
};
await import(${JSON.stringify(pathToFileURL(binding.preloadPath).href)});
parentPort.close();
`,
    );
    fs.writeFileSync(
      program,
      `import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
const gate = new SharedArrayBuffer(4);
const launch = (pause) => new Worker(${JSON.stringify(workerPath)}, {
  execArgv: [], workerData: { pause, gate },
});
const first = launch(true);
const firstExit = once(first, "exit");
assert.deepEqual(await once(first, "message"), ["publishing"]);
try {
  const second = launch(false);
  assert.deepEqual(await once(second, "exit"), [0]);
} finally {
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  assert.deepEqual(await firstExit, [0]);
}
`,
    );
    const child = spawnSync(requireNodeTool("node"), [program], {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });

  it.each([
    ["create", "dev"],
    ["validate", "ino"],
  ] as const)(
    "refuses unavailable Windows %s directory %s before database access",
    (phase, field) => {
      const root = temporary.make("openclaw-handoff-unavailable-identity-");
      const binding = phase === "validate" ? createManagedHandoffTestBinding(root) : undefined;
      const original = fs.lstatSync;
      try {
        // Inject only the unavailable OS identity; keep actual directory and alias checks.
        vi.stubGlobal("process", { ...process, platform: "win32" });
        vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof original>) => {
          const stat = original(...args);
          if (args[0] === root) {
            Object.defineProperty(stat, field, { value: 0n });
          }
          return stat;
        }) as typeof original);
        expect(() =>
          binding ? binding.assertPath() : createManagedHandoffTestBinding(root),
        ).toThrow(/identity is unavailable/);
        expect(fs.existsSync(path.join(root, "managed-update-handoffs.sqlite"))).toBe(false);
        if (!binding) {
          expect(fs.readdirSync(root)).toEqual([]);
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );

  it("preserves consumer import/require conditions and explicitly selected caches", () => {
    const { root, binding, program, run } = fixture();
    const cache = temporary.make("openclaw-explicit-cache-");
    const consumer = path.join(root, "consumer-package");
    const dependency = path.join(consumer, "node_modules", "@openclaw", "fs-safe");
    fs.mkdirSync(dependency, { recursive: true });
    const original = require.resolve("@openclaw/fs-safe/temp");
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe",
        exports: { "./temp": { import: "./temp.mjs", require: "./temp-require.mjs" } },
      }),
    );
    fs.writeFileSync(
      path.join(dependency, "temp.mjs"),
      `export * from ${JSON.stringify(pathToFileURL(original).href)};\n` +
        'export const fixtureConsumer = "esm";\n',
    );
    fs.writeFileSync(
      path.join(dependency, "temp-require.mjs"),
      `export * from ${JSON.stringify(pathToFileURL(original).href)};\n` +
        'export const fixtureConsumer = "commonjs";\n',
    );
    const manifest = path.join(consumer, "package.json");
    fs.writeFileSync(manifest, '{"name":"handoff-consumer","private":true,"type":"module"}');
    const esmConsumer = path.join(consumer, "consumer.mjs");
    fs.writeFileSync(esmConsumer, 'export * from "@openclaw/fs-safe/temp";\n');
    fs.writeFileSync(
      program,
      [
        'import { createRequire } from "node:module";',
        `const require = createRequire(${JSON.stringify(manifest)});`,
        'const required = require("@openclaw/fs-safe/temp");',
        `const imported = await import(${JSON.stringify(pathToFileURL(esmConsumer).href)});`,
        "process.stdout.write(JSON.stringify([required, imported].map((temp) => ({",
        '  root: temp.resolveSecureTempRoot({ preferredDir: "/tmp/openclaw", fallbackPrefix: "openclaw", skipPreferredOnWindows: true }),',
        `  cache: temp.resolveSecureTempRoot({ preferredDir: ${JSON.stringify(cache)}, fallbackPrefix: "cache", skipPreferredOnWindows: false }),`,
        "  consumer: temp.fixtureConsumer,",
        "}))));",
      ].join("\n"),
    );
    const child = run();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([
      { root, cache, consumer: "commonjs" },
      { root, cache, consumer: "esm" },
    ]);
    assertManagedHandoffTestConsumer(binding, child.pid, root);
  });

  it("refuses aliased, shared, and relative binding roots without allocating there", () => {
    const target = temporary.make("openclaw-handoff-alias-target-");
    const root = temporary.make("openclaw-handoff-alias-container-");
    const alias = path.join(root, "alias");
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    for (const [directory, error] of [
      [alias, /must be real/],
      ["/tmp/openclaw", /Shared/],
      ["/private/tmp/openclaw", /Shared/],
      ["relative-handoff", /absolute/],
    ] as const) {
      expect(() => createManagedHandoffTestBinding(directory)).toThrow(error);
    }
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(["database-symlink", "database-hardlink", "wal-symlink", "parent-replaced"] as const)(
    "refuses %s before executing the store consumer",
    (failure) => {
      const { root, binding, program, run } = fixture();
      const outside = temporary.make("openclaw-handoff-untouched-");
      const protectedFile = path.join(outside, "untouched");
      fs.writeFileSync(protectedFile, "unchanged");
      const entryMarker = path.join(outside, "consumer-started");
      fs.writeFileSync(
        program,
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(entryMarker)}, "started");`,
      );
      if (failure === "parent-replaced") {
        const retired = path.join(outside, "retired-parent");
        fs.renameSync(root, retired);
        fs.mkdirSync(root, { mode: 0o700 });
        for (const file of fs.readdirSync(retired)) {
          fs.copyFileSync(path.join(retired, file), path.join(root, file));
        }
      } else if (failure === "database-hardlink") {
        fs.linkSync(protectedFile, binding.databasePath);
      } else {
        fs.symlinkSync(
          protectedFile,
          binding.databasePath + (failure === "wal-symlink" ? "-wal" : ""),
        );
      }
      const child = run();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(
        /Handoff test (?:database (?:alias|hardlink)|directory identity)/,
      );
      expect(fs.existsSync(entryMarker)).toBe(false);
      expect(fs.readFileSync(protectedFile, "utf8")).toBe("unchanged");
    },
  );
});
