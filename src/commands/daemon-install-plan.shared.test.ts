import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  resolveDaemonInstallPlanInputs,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonServicePathDirs,
} from "./daemon-install-plan.shared.js";

let root: string;
let originalArgv: string[];
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daemon-plan-")));
  originalArgv = process.argv;
});
afterEach(() => {
  process.argv = originalArgv;
  fs.rmSync(root, { recursive: true, force: true });
});

function entrypoint(folder: string, packaged = false) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "openclaw.mjs");
  fs.writeFileSync(file, "");
  if (packaged) {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"openclaw"}');
  }
  return file;
}

describe("resolveDaemonInstallRuntimeInputs", () => {
  it.skipIf(process.platform === "win32")("keeps a persisted runtime pin", async () => {
    const pinned = path.join(root, "node");
    fs.symlinkSync(resolveTestNodeExecPath(), pinned);
    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: {},
        pinnedRuntimePath: pinned,
        runtime: "node",
        devMode: false,
      }),
    ).resolves.toMatchObject({ devMode: false, runtime: "node", runtimePath: pinned });
  });

  it.each([
    ["/Users/me/openclaw/src/cli/index.ts", true],
    ["C:\\Users\\me\\openclaw\\src\\cli\\index.ts", true],
    ["/Users/me/openclaw/dist/cli/index.js", false],
  ] as const)("detects devMode from %s", async (entry, devMode) => {
    process.argv = ["node", entry];
    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: {},
        runtime: "node",
        runtimePath: "/custom/node",
      }),
    ).resolves.toMatchObject({ devMode });
  });
});

describe("durable CLI for an npx copy", () => {
  const plan = () =>
    resolveDaemonInstallPlanInputs({
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      runtime: "node",
      runtimePath: "/custom/node",
      devMode: false,
    });
  beforeEach(() => {
    process.argv = [
      "node",
      entrypoint(path.join(".npm", "_npx", "abc", "node_modules", "openclaw")),
    ];
  });

  it("does not install a durable copy while planning", async () => {
    await expect(plan()).resolves.toMatchObject({ cliEntrypoint: undefined });
    expect(fs.existsSync(path.join(root, "state", "npm"))).toBe(false);
  });
});

describe("resolveDaemonServicePathDirs", () => {
  it.each([
    ["npx", [".npm", "_npx", "abc", "node_modules", ".bin"]],
    ["pnpm dlx", [".cache", "pnpm", "dlx", "abc", "node_modules", ".bin"]],
    ["yarn dlx", ["tmp", "xfs-1a2b3c4d", "dlx-4242", "node_modules", ".bin"]],
    ["bunx", ["tmp", ".bunx-501", "openclaw@latest", "node_modules", ".bin"]],
    ["bunx on Windows", ["tmp", "bunx-501-openclaw", "bin"]],
  ])("leaves %s off the service PATH", (_name, segments) => {
    const shim = entrypoint(path.join(...segments));
    const binDir = path.dirname(shim);
    fs.renameSync(shim, path.join(binDir, "openclaw"));
    expect(
      resolveDaemonServicePathDirs({
        runtimePath: path.resolve("/opt/node/bin/node"),
        argv: ["node", path.join(binDir, "openclaw"), "gateway", "install"],
        env: { PATH: binDir },
        platform: "linux",
      }),
    ).toEqual([path.resolve("/opt/node/bin")]);
  });

  it.skipIf(process.platform === "win32").each([true, false])(
    "accepts only the active installation's PATH shim (same=%s)",
    (same) => {
      const active = entrypoint(same ? "lib/node_modules/openclaw" : "active", !same);
      const target = same ? active : entrypoint("other", true);
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir);
      fs.symlinkSync(target, path.join(binDir, "openclaw"));
      expect(
        resolveDaemonServicePathDirs({
          argv: ["node", active, "gateway", "install"],
          env: { PATH: binDir },
          platform: "darwin",
        }),
      ).toEqual(same ? [binDir] : undefined);
    },
  );

  it.skipIf(process.platform === "win32")(
    "puts the durable copy's launcher folder on the PATH of a service planned from npx",
    () => {
      const npxCli = entrypoint(path.join(".npm", "_npx", "abc", "node_modules", "openclaw"));
      const { binDir } = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(root, "state", "npm"));
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, "openclaw"), "");
      expect(
        resolveDaemonServicePathDirs({
          runtimePath: path.resolve("/opt/node/bin/node"),
          argv: ["node", npxCli, "gateway", "install"],
          env: { OPENCLAW_STATE_DIR: path.join(root, "state"), PATH: "" },
          platform: "linux",
        }),
      ).toEqual([path.resolve("/opt/node/bin"), binDir]);
    },
  );

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
