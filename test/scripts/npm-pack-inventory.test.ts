import type { ChildProcess } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import {
  collectNpmPackInventory,
  compareNpmPackInventory,
} from "../../scripts/lib/npm-pack-inventory.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { waitForDead } from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createPackageFixture(root = tempDirs.make("openclaw-npm-pack-inventory-test-")): {
  packageRoot: string;
  root: string;
} {
  const packageRoot = join(root, "package");
  mkdirSync(packageRoot);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "inventory-fixture", version: "1.0.0" }),
  );
  return { packageRoot, root };
}

function fakeNpmEnvironment(
  root: string,
  body: string,
): {
  runnerParams: { execPath: string; platform: NodeJS.Platform };
  sourceEnv: NodeJS.ProcessEnv;
} {
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const scriptPath = join(binDir, "fake-npm.mjs");
  writeFileSync(scriptPath, body);
  if (process.platform === "win32") {
    writeFileSync(
      join(binDir, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
  } else {
    const wrapperPath = join(binDir, "npm");
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    chmodSync(wrapperPath, 0o755);
  }
  return {
    runnerParams: {
      execPath: join(binDir, process.platform === "win32" ? "node.exe" : "node"),
      platform: process.platform,
    },
    sourceEnv: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

describe("npm pack inventory", () => {
  it("packs the package root once from an isolated npm sandbox without a version probe", async () => {
    const { packageRoot, root } = createPackageFixture();
    const capturePath = join(root, "capture.json");
    const npm = fakeNpmEnvironment(
      root,
      [
        "import fs from 'node:fs';",
        "fs.appendFileSync(process.env.OPENCLAW_TEST_CAPTURE, JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  home: process.env.HOME,",
        "  npmConfigKeys: Object.keys(process.env).filter((key) => /^npm_config_/i.test(key)).sort(),",
        "}) + '\\n');",
        "if (process.argv.includes('--version')) { throw new Error('Unexpected npm version probe'); }",
        "process.stdout.write(JSON.stringify([{ files: [{ path: 'package.json' }] }]));",
      ].join("\n"),
    );
    npm.sourceEnv.OPENCLAW_TEST_CAPTURE = capturePath;
    npm.sourceEnv.npm_config_registry = "https://example.invalid";
    npm.sourceEnv.NPM_CONFIG_SCRIPT_SHELL = "forbidden-shell";

    const result = await collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 });
    const captures = readFileSync(capturePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      args: string[];
      cwd: string;
      home: string;
      npmConfigKeys: string[];
    }>;

    expect(result).toMatchObject({ files: ["package.json"] });
    expect(captures).toHaveLength(1);
    const [packCapture] = captures;
    if (!packCapture) {
      throw new Error("Expected npm pack capture.");
    }
    expect(packCapture.cwd).not.toBe(packageRoot);
    expect(packCapture.args.slice(0, 3)).toEqual([
      `--prefix=${packCapture.cwd}`,
      "pack",
      packageRoot,
    ]);
    expect(packCapture.home).not.toBe(process.env.HOME);
    expect(packCapture.npmConfigKeys).not.toContain("npm_config_registry");
    expect(packCapture.npmConfigKeys).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(packCapture.args).toEqual(
      expect.arrayContaining([
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--offline",
        "--workspaces=false",
      ]),
    );
  });

  it("reports missing and extra paths in normalized sorted order", () => {
    expect(
      compareNpmPackInventory(
        ["package.json", "dist/extra.js"],
        ["package.json", "dist/missing.js"],
      ),
    ).toEqual({
      extra: ["dist/extra.js"],
      missing: ["dist/missing.js"],
    });
  });

  it("excludes host-npm-version-variant paths from inventory parity", () => {
    expect(
      compareNpmPackInventory(
        ["package.json", "npm-shrinkwrap.json"],
        ["package.json"],
        ["npm-shrinkwrap.json"],
      ),
    ).toEqual({ extra: [], missing: [] });
  });

  it("accepts npm 12 name-keyed package results", async () => {
    const { packageRoot, root } = createPackageFixture();
    const npm = fakeNpmEnvironment(
      root,
      `process.stdout.write(JSON.stringify({ "inventory-fixture": { files: [{ path: "package.json" }, { path: "./dist/index.js" }] } }));`,
    );

    await expect(
      collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 }),
    ).resolves.toMatchObject({
      files: ["dist/index.js", "package.json"],
    });
  });

  it.each([
    { name: "successful pack", exitCode: 0 },
    { name: "failed pack", exitCode: 23 },
  ])(
    "suppresses npm 10 lifecycle scripts and restores package.json after $name",
    async ({ exitCode }) => {
      const { packageRoot, root } = createPackageFixture();
      const packageJsonPath = join(packageRoot, "package.json");
      const capturePath = join(root, "scripts-capture.json");
      const originalBytes = Buffer.from(
        '{\n\t"version" : "1.0.0",\n\t"scripts" : { "prepack" : "exit 99" },\n\t"name" : "inventory-fixture"\n}\n',
      );
      writeFileSync(packageJsonPath, originalBytes);
      chmodSync(packageJsonPath, 0o444);
      const originalMode = statSync(packageJsonPath).mode;
      const npm = fakeNpmEnvironment(
        root,
        [
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "const packIndex = process.argv.indexOf('pack');",
          "const packageRoot = process.argv[packIndex + 1];",
          "const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));",
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CAPTURE, JSON.stringify({ hasScripts: Object.hasOwn(packageJson, 'scripts') }));",
          exitCode === 0
            ? "process.stdout.write(JSON.stringify([{ files: [{ path: 'package.json' }] }]));"
            : `process.stderr.write('simulated npm 10 failure\\n'); process.exit(${exitCode});`,
        ].join("\n"),
      );
      npm.sourceEnv.OPENCLAW_TEST_CAPTURE = capturePath;

      if (exitCode === 0) {
        await expect(
          collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 }),
        ).resolves.toMatchObject({
          files: ["package.json"],
        });
      } else {
        await expect(
          collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 }),
        ).rejects.toThrow("npm pack inventory failed: simulated npm 10 failure");
      }

      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({ hasScripts: false });
      expect(readFileSync(packageJsonPath)).toEqual(originalBytes);
      expect(statSync(packageJsonPath).mode).toBe(originalMode);
    },
  );

  it.each([
    {
      name: "malformed JSON",
      body: "process.stdout.write('{');",
      error: "npm pack returned invalid JSON",
    },
    {
      name: "multiple package results",
      body: `process.stdout.write(JSON.stringify([{ files: [] }, { files: [] }]));`,
      error: "npm pack JSON must contain exactly one package result",
    },
    {
      name: "duplicate paths",
      body: `process.stdout.write(JSON.stringify([{ files: [{ path: "package.json" }, { path: "package.json" }] }]));`,
      error: "npm pack returned duplicate package path package.json",
    },
  ])("fails closed on $name", async ({ body, error }) => {
    const { packageRoot, root } = createPackageFixture();
    const npm = fakeNpmEnvironment(root, body);

    await expect(
      collectNpmPackInventory(packageRoot, { ...npm, timeoutMs: 2_000 }),
    ).rejects.toThrow(error);
  });

  it("fails closed when npm is missing", async () => {
    const { packageRoot, root } = createPackageFixture();
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    await expect(
      collectNpmPackInventory(packageRoot, {
        runnerParams: {
          execPath: join(emptyBin, process.platform === "win32" ? "node.exe" : "node"),
          platform: process.platform,
        },
        sourceEnv: { ...process.env, PATH: emptyBin },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(
      /(?:npm pack inventory executable was not found|failed to resolve a toolchain-local npm)/u,
    );
  });

  it.each([
    {
      name: "npm pack times out",
      body: "setTimeout(() => process.stdout.write(JSON.stringify([{ files: [] }])), 10_000);",
      timeoutMs: 1_000,
      error: "npm pack inventory timed out after 1000ms",
    },
    ...(["stdout", "stderr", "combined"] as const).map((stream) => ({
      name: `npm ${stream} exceeds its byte limit`,
      body: [
        "const chunk = Buffer.alloc(1024 * 1024, Buffer.from([0xc3, 0xa9]));",
        "for (let index = 0; index < 65; index += 1) {",
        `  const output = ${stream === "combined" ? "index % 2 === 0 ? process.stdout : process.stderr" : `process.${stream}`};`,
        "  if (!output.write(chunk)) await once(output, 'drain');",
        "}",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      timeoutMs: 2_000,
      error: "npm pack inventory exceeded its output limit",
    })),
  ])(
    "joins the child before restoring or deleting inputs when $name",
    async ({ body, timeoutMs, error }) => {
      const fixture = createFixtureLifetime();
      const root = fixture.createTempDir("openclaw-npm-pack-lifetime-");
      const capturePath = join(root, "child.json");
      const releasePath = join(root, "release");
      const closed = createDeferred();
      let child: ChildProcess | undefined;
      let admitted = false;
      await runQaGatewayFixture(
        () =>
          fixture.run(async () => {
            const { packageRoot } = createPackageFixture(root);
            const packageJsonPath = join(packageRoot, "package.json");
            const originalBytes = Buffer.from(
              '{"name":"inventory-fixture","version":"1.0.0","scripts":{"prepack":"exit 99"}}\n',
            );
            writeFileSync(packageJsonPath, originalBytes);
            chmodSync(packageJsonPath, 0o444);
            const originalMode = statSync(packageJsonPath).mode;
            const npm = fakeNpmEnvironment(
              root,
              [
                "import fs from 'node:fs';",
                "import path from 'node:path';",
                "import { once } from 'node:events';",
                `setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0); }, 20).unref();`,
                "const packageRoot = process.argv[process.argv.indexOf('pack') + 1];",
                "const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));",
                "fs.writeFileSync(process.env.OPENCLAW_TEST_CAPTURE + '.tmp', JSON.stringify({",
                "  pid: process.pid, cwd: process.cwd(), hasScripts: Object.hasOwn(manifest, 'scripts'),",
                "}));",
                "fs.renameSync(process.env.OPENCLAW_TEST_CAPTURE + '.tmp', process.env.OPENCLAW_TEST_CAPTURE);",
                body,
              ].join("\n"),
            );
            npm.sourceEnv.OPENCLAW_TEST_CAPTURE = capturePath;
            const released: string[] = [];
            const assertJoined = (boundary: string) => {
              const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
                pid: number;
                cwd: string;
                hasScripts: boolean;
              };
              expect(capture.hasScripts).toBe(false);
              let probeError: unknown;
              try {
                process.kill(capture.pid, 0);
              } catch (error) {
                probeError = error;
              }
              expect(probeError, `${boundary} preceded child termination`).toMatchObject({
                code: "ESRCH",
              });
              released.push(boundary);
            };
            const write = fs.writeFileSync;
            const remove = fs.rmSync;
            const runManagedCommand = managedChild.runManagedCommand;
            const command = vi
              .spyOn(managedChild, "runManagedCommand")
              .mockImplementation((options) =>
                runManagedCommand({
                  ...options,
                  onReady(spawned) {
                    child = spawned;
                    spawned.once("close", () => closed.resolve());
                    options.onReady?.(spawned);
                  },
                }),
              );
            const temporaryRoot = vi.spyOn(os, "tmpdir").mockReturnValue(root);
            const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
              if (
                args[0] === packageJsonPath &&
                Buffer.isBuffer(args[1]) &&
                args[1].equals(originalBytes)
              ) {
                assertJoined("manifest");
              }
              return write(...args);
            });
            const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
              if (existsSync(capturePath)) {
                const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { cwd: string };
                if (args[0] === dirname(capture.cwd)) {
                  assertJoined("sandbox");
                }
              }
              return remove(...args);
            });

            try {
              admitted = true;
              await expect(
                collectNpmPackInventory(packageRoot, { ...npm, timeoutMs }),
              ).rejects.toThrow(error);
              expect(released).toEqual(["manifest", "sandbox"]);
              expect(readFileSync(packageJsonPath)).toEqual(originalBytes);
              expect(statSync(packageJsonPath).mode).toBe(originalMode);
              const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { cwd: string };
              expect(existsSync(dirname(capture.cwd))).toBe(false);
            } finally {
              writeSpy.mockRestore();
              removeSpy.mockRestore();
              temporaryRoot.mockRestore();
              command.mockRestore();
            }
          }),
        () =>
          fixture.verifyCleanup(async () => {
            // Assertions precede rescue. Only this private fixture observes the release;
            // no signal targets a recorded PID after its owner may have exited.
            writeFileSync(releasePath, "release");
            if (child) {
              await withTestTimeout(closed.promise, 2_000, "npm fixture launcher did not close");
            }
            if (existsSync(capturePath)) {
              const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { pid: number };
              await waitForDead(capture.pid, 2_000);
            } else if (admitted && (!child || child.pid)) {
              throw new Error("npm fixture descendant identity was not published");
            }
          }),
        () => fixture.cleanup(),
      );
    },
  );

  it.each(["direct", "nested"] as const)(
    "retains stripped inputs and cleanup provenance after %s unjoined work",
    async (shape) => {
      const { packageRoot, root } = createPackageFixture();
      const packageJsonPath = join(packageRoot, "package.json");
      writeFileSync(
        packageJsonPath,
        '{"name":"inventory-fixture","version":"1.0.0","scripts":{"prepack":"exit 99"}}',
      );
      chmodSync(packageJsonPath, 0o444);
      const cleanupError = Object.assign(new Error("Windows tree cleanup could not be verified"), {
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "indeterminate",
        manualRecoveryRequired: true,
      });
      const failure =
        shape === "direct"
          ? cleanupError
          : new AggregateError([new Error("capture failed")], "cleanup failed", {
              cause: cleanupError,
            });
      let sandboxCwd: string | undefined;
      const temporaryRoot = vi.spyOn(os, "tmpdir").mockReturnValue(root);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const command = vi
        .spyOn(managedChild, "runManagedCommand")
        .mockImplementation(async (options) => {
          sandboxCwd = options.cwd;
          throw failure;
        });
      try {
        const error: unknown = await collectNpmPackInventory(packageRoot, {
          timeoutMs: 2_000,
        }).catch((error: unknown) => error);
        if (!(error instanceof Error)) {
          throw new Error("Expected npm inventory failure");
        }
        expect(error.cause).toBe(failure);
        expect(managedChild.hasUnjoinedWork(error)).toBe(true);
        expect(command).toHaveBeenCalledOnce();
        expect(JSON.parse(readFileSync(packageJsonPath, "utf8"))).not.toHaveProperty("scripts");
        if (!sandboxCwd) {
          throw new Error("npm sandbox was not admitted");
        }
        expect(existsSync(sandboxCwd)).toBe(true);
        expect(existsSync(join(dirname(sandboxCwd), "config", "user.npmrc"))).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("child cleanup unverified; retained"),
        );
      } finally {
        command.mockRestore();
        log.mockRestore();
        temporaryRoot.mockRestore();
      }
    },
  );
});
