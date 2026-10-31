import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
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
    ).resolves.toEqual({ devMode: false, runtime: "node", runtimePath: pinned });
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

describe("resolveDaemonServicePathDirs", () => {
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
