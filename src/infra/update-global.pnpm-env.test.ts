import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { validatePnpmIsolatedUpdate } from "./package-update-manager-preflight.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { packageUpdateStepResult, writePackageRoot } from "./package-update-steps.test-support.js";
import { createGlobalInstallEnv, resolveGlobalInstallTarget } from "./update-global.js";

it("runs pnpm v11 preflight from its install home when the service PATH excludes pnpm", async () => {
  await withTestDir({ prefix: "openclaw-update-pnpm-env-" }, async (base) => {
    const pnpmHome = path.join(base, "pnpm home");
    const binDir = path.join(pnpmHome, "bin");
    const globalRoot = path.join(pnpmHome, "global", "v11");
    const projectRoot = path.join(globalRoot, "project");
    const packageRoot = path.join(projectRoot, "node_modules", "openclaw");
    const serviceBin = path.join(base, "service-bin");
    await Promise.all([
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(binDir, { recursive: true }),
      fs.mkdir(serviceBin),
    ]);
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { openclaw: "1.0.0" } }),
    );
    await fs.symlink(projectRoot, path.join(globalRoot, "hash-openclaw"), "dir");
    const probeScript = path.join(base, "pnpm-probe.cjs");
    await fs.writeFile(
      probeScript,
      `const path = require("node:path");
const home = ${JSON.stringify(pnpmHome)};
const bin = path.join(home, "bin");
if (process.env.PNPM_HOME !== home || !(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).includes(bin)) {
  console.error("ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH");
  process.exit(1);
}
console.log(process.argv[2] === "root" ? path.join(home, "global", "v11") : bin);
`,
    );
    const pnpmCommand = path.join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    await fs.writeFile(
      pnpmCommand,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${probeScript}" %*\r\n`
        : `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} ${quoteCliArg(probeScript)} "$@"\n`,
      { mode: 0o755 },
    );
    const runCommand = vi.fn(runCommandWithTimeout);
    const installTarget = await resolveGlobalInstallTarget({
      manager: "pnpm",
      pkgRoot: packageRoot,
      runCommand,
      timeoutMs: 1000,
    });
    const serviceEnv = { HOME: base, PATH: serviceBin, PNPM_HOME: path.join(base, "other-home") };
    const env = await createGlobalInstallEnv(serviceEnv, installTarget);
    const result = await validatePnpmIsolatedUpdate({
      installTarget,
      packageName: "openclaw",
      runCommand,
      timeoutMs: 1000,
      env,
    });

    expect(result.failedStep).toBeNull();
    expect(result.globalBinDir).toBe(binDir);
    expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([
      [pnpmCommand, "root", "-g"],
      [pnpmCommand, "bin", "-g"],
    ]);
    expect(env.PNPM_HOME).toBe(pnpmHome);
    expect(env.PATH?.split(path.delimiter)).toEqual([binDir, pnpmHome, serviceBin]);
    expect(serviceEnv.PATH).toBe(serviceBin);
    expect(serviceEnv.PNPM_HOME).toBe(path.join(base, "other-home"));
  });
});

it.each([false, true])(
  "stages pnpm 10 through its home shim with PNPM_HOME on PATH: %s",
  async (onPath) => {
    await withTestDir({ prefix: "openclaw-update-pnpm10-env-" }, async (base) => {
      const pnpmHome = path.join(base, "pnpm home");
      const globalRoot = path.join(pnpmHome, "global", "5", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const otherBin = path.join(base, "version-manager");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(otherBin);
      await fs.writeFile(path.join(globalRoot, ".modules.yaml"), "");
      await fs.writeFile(
        path.join(globalRoot, "..", "package.json"),
        '{"dependencies":{"openclaw":"1.0.0"}}',
      );
      const probeScript = path.join(base, "pnpm-probe.cjs");
      await fs.writeFile(
        probeScript,
        `const path = require("node:path");
const home = ${JSON.stringify(pnpmHome)};
const args = process.argv.slice(2);
const option = (key) => args.find(arg => arg.startsWith(key + "="))?.slice(key.length + 1);
const project = option("--config.global-dir") ?? path.join(home, "global");
const bin = option("--config.global-bin-dir") ?? home;
if (process.env.PNPM_HOME !== home || !process.env.PATH.split(path.delimiter).includes(bin)) {
  console.error("ERROR The configured global bin directory " + JSON.stringify(bin) + " is not in PATH");
  process.exit(1);
}
console.log(args[0] === "root" ? path.join(project, "5", "node_modules") : bin);
`,
      );
      const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      const pnpmCommand = path.join(pnpmHome, executable);
      await fs.writeFile(
        pnpmCommand,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${probeScript}" %*\r\n`
          : `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} ${quoteCliArg(probeScript)} "$@"\n`,
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(otherBin, executable),
        process.platform === "win32"
          ? "@echo off\r\necho wrong pnpm owner 1>&2\r\nexit /b 1\r\n"
          : "#!/bin/sh\necho wrong pnpm owner >&2\nexit 1\n",
        { mode: 0o755 },
      );
      const sourceEnv = {
        HOME: base,
        PNPM_HOME: pnpmHome,
        PATH: [otherBin, ...(onPath ? [pnpmHome] : [])].join(path.delimiter),
      };
      const runCommand = vi.fn(runCommandWithTimeout);
      const installTarget = await resolveGlobalInstallTarget({
        manager: "pnpm",
        pkgRoot: packageRoot,
        runCommand,
        timeoutMs: 1000,
        env: sourceEnv,
      });
      const env = await createGlobalInstallEnv(sourceEnv, installTarget);
      const runStep = vi.fn(async (step: Parameters<typeof packageUpdateStepResult>[0]) => {
        expect(step.argv[0]).toBe(pnpmCommand);
        expect(step.cwd).toContain(path.join(pnpmHome, ".openclaw-update-native-"));
        return packageUpdateStepResult(step, {
          exitCode: 1,
          stderrTail: "proof stopped before install",
        });
      });
      const result = await runGlobalPackageUpdateSteps({
        installTarget,
        packageRoot,
        packageName: "openclaw",
        installSpec: "openclaw@2.0.0",
        env,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });
      expect(result.failedStep?.stderrTail).toBe("proof stopped before install");
      expect(runStep).toHaveBeenCalledOnce();
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(
        JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version,
      ).toBe("1.0.0");
    });
  },
);
