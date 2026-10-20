import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonServicePathDirs,
} from "./daemon-install-plan.shared.js";

async function withTempDir(run: (root: string) => unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daemon-plan-")));
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(file: string, text = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function discover(entrypoint: string, binDir: string) {
  return resolveDaemonServicePathDirs({
    argv: ["node", entrypoint, "gateway", "install"],
    env: { PATH: binDir },
    platform: "darwin",
  });
}

describe("resolveDaemonInstallRuntimeInputs", () => {
  it.skipIf(process.platform === "win32")(
    "keeps a persisted runtime pin instead of selecting system Node",
    () =>
      withTempDir(async (root) => {
        const pinned = path.join(root, "node");
        fs.symlinkSync(resolveTestNodeExecPath(), pinned);
        await expect(
          resolveDaemonInstallRuntimeInputs({
            env: {},
            pinnedRuntimePath: pinned,
            runtime: "node",
            devMode: false,
          }),
        ).resolves.toEqual({ devMode: false, runtime: "node", runtimePath: pinned });
      }),
  );

  it("detects src ts entrypoints when devMode is not overridden", async () => {
    const originalArgv = process.argv;
    try {
      for (const [entrypoint, expected] of [
        ["/Users/me/openclaw/src/cli/index.ts", true],
        ["C:\\Users\\me\\openclaw\\src\\cli\\index.ts", true],
        ["/Users/me/openclaw/dist/cli/index.js", false],
      ] as const) {
        process.argv = ["node", entrypoint];
        await expect(
          resolveDaemonInstallRuntimeInputs({
            env: {},
            runtime: "node",
            runtimePath: "/custom/node",
          }),
        ).resolves.toMatchObject({ devMode: expected });
      }
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe("resolveDaemonServicePathDirs openclaw discovery", () => {
  it.skipIf(process.platform === "win32")(
    "finds the PATH shim that resolves to the active package entrypoint",
    () =>
      withTempDir((root) => {
        const binDir = path.join(root, "bin");
        const packageDir = path.join(root, "lib", "node_modules", "openclaw");
        const entrypoint = writeFile(path.join(packageDir, "openclaw.mjs"));
        fs.mkdirSync(binDir, { recursive: true });
        fs.symlinkSync(entrypoint, path.join(binDir, "openclaw"));

        expect(discover(entrypoint, binDir)).toEqual([binDir]);
      }),
  );

  it.skipIf(process.platform === "win32")(
    "ignores unrelated openclaw commands elsewhere on PATH",
    () =>
      withTempDir((root) => {
        const binDir = path.join(root, "bin");
        const activeEntrypoint = writeFile(path.join(root, "active", "openclaw.mjs"));
        const otherEntrypoint = writeFile(path.join(root, "other", "openclaw.mjs"));
        fs.mkdirSync(binDir, { recursive: true });
        for (const entrypoint of [activeEntrypoint, otherEntrypoint]) {
          writeFile(path.join(path.dirname(entrypoint), "package.json"), '{"name":"openclaw"}');
        }
        fs.symlinkSync(otherEntrypoint, path.join(binDir, "openclaw"));

        expect(discover(activeEntrypoint, binDir)).toBeUndefined();
      }),
  );
});

describe("resolveDaemonServicePathDirs", () => {
  it("combines runtime and active openclaw command directories", () => {
    expect(
      resolveDaemonServicePathDirs({
        runtimePath: "/opt/homebrew/opt/node/bin/node",
        argv: ["node", "/Users/testuser/.npm-global/bin/openclaw", "gateway", "install"],
        env: { PATH: "" },
        platform: "darwin",
      }),
    ).toEqual(["/opt/homebrew/opt/node/bin", "/Users/testuser/.npm-global/bin"]);
  });
});
