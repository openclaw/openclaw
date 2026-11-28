import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveGatewayProgramArguments,
  resolveNodeProgramArguments,
} from "../daemon/program-args.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  resolveDaemonInstallPlanInputs,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonServicePathDirs,
} from "./daemon-install-plan.shared.js";
import { buildExpectedGatewayServicePlan } from "./doctor-gateway-runtime-plan.js";

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
      service: "gateway",
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      runtime: "node",
      runtimePath: "/custom/node",
      devMode: false,
    });
  beforeEach(() => {
    const npx = entrypoint(path.join(".npm", "_npx", "abc", "node_modules", "openclaw"));
    fs.writeFileSync(path.join(npx, "..", "package.json"), '{"name":"openclaw","version":"1.2.3"}');
    fs.mkdirSync(path.join(npx, "..", "dist"));
    fs.writeFileSync(path.join(npx, "..", "dist", "index.js"), "");
    process.argv = ["node", npx];
  });

  it("names the explicit install instead of planning a missing durable copy", async () => {
    // Doctor keeps the service's CLI instead of planning the npx entry.
    const retained = path.join(root, "global", "dist", "index.js");
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    fs.writeFileSync(retained, "");
    const doctorPlan = await buildExpectedGatewayServicePlan({
      cfg: {},
      command: { programArguments: [process.execPath, retained, "gateway"] },
      serviceInstallEnv: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      port: 18789,
      runtime: "node",
      runtimePath: process.execPath,
    });
    expect(doctorPlan.programArguments).toContain(retained);
    await expect(plan()).rejects.toThrow(/missing.*npx openclaw@1\.2\.3 gateway install --force/u);
    expect(fs.existsSync(path.join(root, "state", "npm"))).toBe(false);
  });

  it.each([
    ["gateway", ["dist", "index.js"]],
    ["node", ["openclaw.mjs"]],
  ] as const)(
    "plans a first %s install with the real argument builder before the copy exists",
    async (service, entry) => {
      const inputs = await resolveDaemonInstallPlanInputs({
        service,
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        runtime: "node",
        runtimePath: "/custom/node",
        devMode: false,
        installDurableCli: true,
      });
      const { programArguments } =
        service === "gateway"
          ? await resolveGatewayProgramArguments({ ...inputs, port: 18789 })
          : await resolveNodeProgramArguments({ ...inputs, host: "127.0.0.1", port: 18789 });

      const durableRoot = path.join(
        resolveNpmGlobalPrefixLayoutFromPrefix(path.join(root, "state", "npm")).globalRoot,
        "openclaw",
      );
      expect(programArguments).toContain(path.join(durableRoot, ...entry));
      expect(inputs.durableCliReplacement?.entrypoint).toBe(path.join(durableRoot, ...entry));
      expect(fs.existsSync(durableRoot)).toBe(false);
    },
  );
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
