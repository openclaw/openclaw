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
  return { root, binding, program };
}

describe("explicit managed handoff test binding", () => {
  it.each(["inherited", "service-sanitized", "replaced", "NODE_OPTIONS-deleted"] as const)(
    "opens the real lease store after %s environment selection",
    (selection) => {
      const { root, binding, program } = fixture();
      const env =
        selection === "service-sanitized"
          ? resolveServiceManagerEnv()
          : selection === "replaced"
            ? { ...resolveServiceManagerEnv(), HOME: root, USERPROFILE: root }
            : { ...process.env };
      if (selection !== "inherited") {
        delete env.NODE_OPTIONS;
      }
      const child = spawnSync(process.execPath, [binding.nodeOption, program], {
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result).toMatchObject({
        databasePath: binding.databasePath,
        observed: { kind: "current", lease: { owner: "binding-owner" } },
        result: { kind: "absent" },
      });
      if (selection !== "inherited") {
        expect(result.nodeOptions).toBeNull();
      }
      expect(fs.statSync(binding.databasePath).isFile()).toBe(true);
      expect(binding.assertPath(result.databasePath)).toBe(binding.databasePath);
      assertManagedHandoffTestConsumer(binding, child.pid, path.resolve("src"));
      const witnesses = fs.readdirSync(root).filter((name) => name.startsWith("preflight-"));
      expect(witnesses.length).toBeGreaterThan(0);
      for (const name of witnesses) {
        expect(JSON.parse(fs.readFileSync(path.join(root, name), "utf8"))).toMatchObject({
          pid: child.pid,
          databasePath: binding.databasePath,
          realParent: root,
        });
      }
    },
  );

  it("does not credit preload setup as target consumer use", () => {
    const { binding, program, root } = fixture();
    fs.writeFileSync(program, 'process.stdout.write("entrypoint-ran");');
    const child = spawnSync(process.execPath, [binding.nodeOption, program], {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("entrypoint-ran");
    expect(fs.readdirSync(root).some((name) => name.startsWith("preflight-"))).toBe(true);
    expect(() =>
      assertManagedHandoffTestConsumer(binding, child.pid, path.resolve("test")),
    ).toThrow(/No bound handoff resolver witness/);
    expect(fs.existsSync(binding.databasePath)).toBe(false);
  });

  it.each([
    ["create", "dev"],
    ["create", "ino"],
    ["validate", "dev"],
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

  it("binds a separately resolved consumer package's CommonJS dependency", () => {
    const { root, binding, program } = fixture();
    const consumer = path.join(root, "consumer-package");
    const dependency = path.join(consumer, "node_modules", "@openclaw", "fs-safe");
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    const packageRoot = path.dirname(path.dirname(require.resolve("@openclaw/fs-safe/temp")));
    fs.symlinkSync(packageRoot, dependency, process.platform === "win32" ? "junction" : "dir");
    const manifest = path.join(consumer, "package.json");
    fs.writeFileSync(manifest, '{"name":"handoff-consumer","private":true,"type":"module"}');
    fs.writeFileSync(
      program,
      [
        'import { createRequire } from "node:module";',
        `const require = createRequire(${JSON.stringify(manifest)});`,
        'const { resolveSecureTempRoot } = require("@openclaw/fs-safe/temp");',
        'process.stdout.write(resolveSecureTempRoot({ preferredDir: "/tmp/openclaw", fallbackPrefix: "openclaw", skipPreferredOnWindows: true }));',
      ].join("\n"),
    );
    const child = spawnSync(process.execPath, [binding.nodeOption, program], {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(root);
    assertManagedHandoffTestConsumer(binding, child.pid, root);
  });

  it("preserves an explicitly selected application cache", () => {
    const { binding, program } = fixture();
    const cache = temporary.make("openclaw-explicit-cache-");
    fs.writeFileSync(
      program,
      [
        'import { createRequire } from "node:module";',
        `const require = createRequire(${JSON.stringify(path.join(process.cwd(), "package.json"))});`,
        'const { resolveSecureTempRoot } = require("@openclaw/fs-safe/temp");',
        `process.stdout.write(resolveSecureTempRoot({ preferredDir: ${JSON.stringify(cache)}, fallbackPrefix: "cache", skipPreferredOnWindows: false }));`,
      ].join("\n"),
    );
    const child = spawnSync(process.execPath, [binding.nodeOption, program], {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(cache);
  });

  it("refuses a directory alias before creating a preload in its target", () => {
    const target = temporary.make("openclaw-handoff-alias-target-");
    const root = temporary.make("openclaw-handoff-alias-container-");
    const alias = path.join(root, "alias");
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => createManagedHandoffTestBinding(alias)).toThrow(/must be real/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(["database-symlink", "database-hardlink", "wal-symlink", "parent-replaced"] as const)(
    "refuses %s before executing the store consumer",
    (failure) => {
      const { root, binding, program } = fixture();
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
      const child = spawnSync(process.execPath, [binding.nodeOption, program], {
        env: resolveServiceManagerEnv(),
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(
        /Handoff test (?:database (?:alias|hardlink)|directory identity)/,
      );
      expect(fs.existsSync(entryMarker)).toBe(false);
      expect(fs.readFileSync(protectedFile, "utf8")).toBe("unchanged");
    },
  );

  it("refuses shared and relative binding roots without allocating there", () => {
    expect(() => createManagedHandoffTestBinding("/tmp/openclaw")).toThrow(/Shared/);
    expect(() => createManagedHandoffTestBinding("/private/tmp/openclaw")).toThrow(/Shared/);
    expect(() => createManagedHandoffTestBinding("relative-handoff")).toThrow(/absolute/);
  });
});
