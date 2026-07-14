import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-dist-inventory.js";
import { resolvePackageRuntime, runStagedPackageLifecycle } from "./package-update-lifecycle.js";

async function writeCandidate(params: {
  packageRoot: string;
  engine?: string;
  guard?: boolean;
  preinstall?: string | null;
  install?: string | null;
  postinstall?: string | null;
  prepare?: string | null;
  writePostinstallFile?: boolean;
}): Promise<void> {
  const scriptPath = path.join(params.packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.join(params.packageRoot, "dist"), { recursive: true });
  const writes = [
    fs.writeFile(
      path.join(params.packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2.0.0",
        engines: { node: params.engine ?? ">=0.0.0" },
        scripts: {
          ...(params.preinstall === null
            ? {}
            : {
                preinstall:
                  params.preinstall ?? "node scripts/preinstall-package-manager-warning.mjs",
              }),
          ...(params.install === null || params.install === undefined
            ? {}
            : { install: params.install }),
          ...(params.postinstall === null
            ? {}
            : {
                postinstall: params.postinstall ?? "node scripts/postinstall-bundled-plugins.mjs",
              }),
          ...(params.prepare === null
            ? {}
            : { prepare: params.prepare ?? "node scripts/prepare-git-hooks.mjs" }),
        },
      }),
      "utf8",
    ),
  ];
  if (params.writePostinstallFile !== false) {
    writes.push(fs.writeFile(scriptPath, "// test postinstall\n", "utf8"));
  }
  await Promise.all(writes);
  if (params.guard) {
    await fs.writeFile(
      path.join(params.packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
      "preinstall incomplete\n",
      "utf8",
    );
  }
}

async function withBunRuntime<T>(run: () => Promise<T>): Promise<T> {
  const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  Object.defineProperty(process.versions, "bun", {
    configurable: true,
    value: "1.3.0",
  });
  try {
    return await run();
  } finally {
    if (bunDescriptor) {
      Object.defineProperty(process.versions, "bun", bunDescriptor);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
  }
}

describe("runStagedPackageLifecycle", () => {
  it("uses the selected runtime for the guard and OpenClaw postinstall", async () => {
    await withTempDir({ prefix: "openclaw-staged-lifecycle-" }, async (packageRoot) => {
      const nodePath = "/opt/openclaw-service/bin/node";
      await writeCandidate({ packageRoot, guard: true, engine: ">=999.0.0" });
      const runStep = vi.fn(async ({ name, argv, cwd }) => ({
        name,
        command: argv.join(" "),
        cwd: cwd ?? process.cwd(),
        durationMs: 1,
        exitCode: 0,
      }));

      const result = await runStagedPackageLifecycle({
        packageRoot,
        runStep,
        timeoutMs: 1_000,
        runtimeVersion: "999.0.0",
        nodePath,
      });

      expect(result.failedStep).toBeNull();
      expect(result.steps.map((step) => step.name)).toEqual([
        "global install runtime guard",
        "global install postinstall",
      ]);
      expect(runStep).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: [nodePath, path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs")],
        }),
      );
      await expect(
        fs.access(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH)),
      ).rejects.toHaveProperty("code", "ENOENT");
    });
  });

  it.each([
    { title: "missing guard", guard: false, engine: ">=0.0.0", message: "missing" },
    { title: "unsupported Node", guard: true, engine: ">=999.0.0", message: "requires Node" },
    {
      title: "missing preinstall contract",
      guard: true,
      engine: ">=0.0.0",
      preinstall: null,
      message: "unsupported preinstall contract",
    },
    {
      title: "changed preinstall contract",
      guard: true,
      engine: ">=0.0.0",
      preinstall: "node scripts/other-preinstall.mjs",
      message: "unsupported preinstall contract",
    },
    {
      title: "added install contract",
      guard: true,
      engine: ">=0.0.0",
      install: "node scripts/install.mjs",
      message: "unsupported install contract",
    },
    {
      title: "missing postinstall contract",
      guard: true,
      engine: ">=0.0.0",
      postinstall: null,
      message: "unsupported postinstall contract",
    },
    {
      title: "changed prepare contract",
      guard: true,
      engine: ">=0.0.0",
      prepare: "node scripts/other-prepare.mjs",
      message: "unsupported prepare contract",
    },
    {
      title: "changed postinstall contract",
      guard: true,
      engine: ">=0.0.0",
      postinstall: "node scripts/other.mjs",
      message: "unsupported postinstall contract",
    },
    {
      title: "missing postinstall file",
      guard: true,
      engine: ">=0.0.0",
      writePostinstallFile: false,
      message: "missing scripts/postinstall-bundled-plugins.mjs",
    },
  ])("rejects a candidate with $title before postinstall", async (testCase) => {
    await withTempDir({ prefix: "openclaw-staged-lifecycle-reject-" }, async (packageRoot) => {
      await writeCandidate({ packageRoot, ...testCase });
      const runStep = vi.fn();

      const result = await runStagedPackageLifecycle({
        packageRoot,
        runStep,
        timeoutMs: 1_000,
      });

      expect(result.failedStep?.name).toBe("global install runtime guard");
      expect(result.failedStep?.stderrTail).toContain(testCase.message);
      expect(runStep).not.toHaveBeenCalled();
    });
  });
});

describe("resolvePackageRuntime", () => {
  it("uses the current runtime when no alternate Node is selected", async () => {
    const runCommand = vi.fn();

    await expect(resolvePackageRuntime({ runCommand, timeoutMs: 20_000 })).resolves.toEqual({
      nodePath: process.execPath,
      version: process.versions.node,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("probes the selected managed-service Node with a bounded timeout", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "v24.15.3\n", stderr: "", code: 0 }));

    await expect(
      resolvePackageRuntime({
        nodePath: "/opt/openclaw/bin/node",
        runCommand,
        timeoutMs: 30_000,
      }),
    ).resolves.toEqual({ nodePath: "/opt/openclaw/bin/node", version: "24.15.3" });
    expect(runCommand).toHaveBeenCalledWith(["/opt/openclaw/bin/node", "--version"], {
      timeoutMs: 10_000,
    });
  });

  it("reuses the hardened PATH probe instead of Bun's temporary node alias", async () => {
    await withBunRuntime(async () => {
      const runCommand = vi.fn();
      const probeNodeRuntime = vi.fn(() => ({
        version: "24.15.3",
        bunVersion: null,
        execPath: "/usr/local/bin/node",
      }));

      await expect(
        resolvePackageRuntime({
          runCommand,
          timeoutMs: 30_000,
          env: { PATH: "/tmp/bun-bin:/usr/local/bin" },
          cwd: "/tmp/openclaw",
          probeNodeRuntime,
        }),
      ).resolves.toEqual({ nodePath: "/usr/local/bin/node", version: "24.15.3" });
      expect(probeNodeRuntime).toHaveBeenCalledWith({
        pathEnv: "/tmp/bun-bin:/usr/local/bin",
        cwd: "/tmp/openclaw",
      });
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  it("rejects a probe result that still resolves to Bun", async () => {
    await withBunRuntime(async () => {
      const probeNodeRuntime = vi.fn(() => ({
        version: "24.15.3",
        bunVersion: "1.3.0",
        execPath: "/tmp/bun-bin/node",
      }));

      await expect(
        resolvePackageRuntime({
          runCommand: vi.fn(),
          timeoutMs: 30_000,
          probeNodeRuntime,
        }),
      ).resolves.toEqual({ nodePath: null, version: null });
    });
  });

  it("runs staged postinstall with PATH Node when the updater uses Bun", async () => {
    await withBunRuntime(async () => {
      await withTempDir({ prefix: "openclaw-staged-lifecycle-bun-" }, async (packageRoot) => {
        await writeCandidate({ packageRoot, guard: true });
        const runStep = vi.fn(async ({ name, argv, cwd }) => ({
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        }));

        const result = await runStagedPackageLifecycle({
          packageRoot,
          runStep,
          timeoutMs: 1_000,
          runtimeVersion: "24.15.3",
          nodePath: "/usr/local/bin/node",
        });

        expect(result.failedStep).toBeNull();
        expect(runStep).toHaveBeenCalledWith(
          expect.objectContaining({
            argv: [
              "/usr/local/bin/node",
              path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
            ],
          }),
        );
      });
    });
  });
});
