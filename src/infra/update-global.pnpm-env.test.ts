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

it.each([
  { major: 11, onPath: false },
  { major: 10, onPath: false },
  { major: 10, onPath: true },
])("uses the installed pnpm $major home (already on PATH: $onPath)", async ({ major, onPath }) => {
  await withTestDir({ prefix: "openclaw-update-pnpm-env-" }, async (base) => {
    const pnpmHome = path.join(base, "pnpm home");
    const binDir = major === 11 ? path.join(pnpmHome, "bin") : pnpmHome;
    const globalRoot = path.join(pnpmHome, "global", major === 11 ? "v11" : "5");
    const projectRoot = major === 11 ? path.join(globalRoot, "project") : globalRoot;
    const packageRoot = path.join(projectRoot, "node_modules", "openclaw");
    const otherBin = path.join(base, "other-bin");
    if (major === 10) {
      await writePackageRoot(packageRoot, "1.0.0");
    } else {
      await fs.mkdir(packageRoot, { recursive: true });
    }
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(otherBin);
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      '{"dependencies":{"openclaw":"1.0.0"}}',
    );
    if (major === 11) {
      await fs.symlink(projectRoot, path.join(globalRoot, "hash-openclaw"), "dir");
    } else {
      await fs.writeFile(path.join(projectRoot, "node_modules", ".modules.yaml"), "");
    }
    const probeScript = path.join(base, "pnpm-probe.cjs");
    await fs.writeFile(
      probeScript,
      `const path = require("node:path");
const home = ${JSON.stringify(pnpmHome)};
` +
        (major === 11
          ? `const bin = path.join(home, "bin");
if (process.env.PNPM_HOME !== home || !(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).includes(bin)) {
  console.error("ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH");
  process.exit(1);
}
console.log(process.argv[2] === "root" ? path.join(home, "global", "v11") : bin);
`
          : `const args = process.argv.slice(2);
const option = (key) => args.find(arg => arg.startsWith(key + "="))?.slice(key.length + 1);
const project = option("--config.global-dir") ?? path.join(home, "global");
const bin = option("--config.global-bin-dir") ?? home;
if (process.env.PNPM_HOME !== home || !process.env.PATH.split(path.delimiter).includes(bin)) {
  console.error("ERROR The configured global bin directory " + JSON.stringify(bin) + " is not in PATH");
  process.exit(1);
}
console.log(args[0] === "root" ? path.join(project, "5", "node_modules") : bin);
`),
    );
    const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const pnpmCommand = path.join(binDir, executable);
    await fs.writeFile(
      pnpmCommand,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${probeScript}" %*\r\n`
        : `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} ${quoteCliArg(probeScript)} "$@"\n`,
      { mode: 0o755 },
    );
    if (major === 10) {
      await fs.writeFile(
        path.join(otherBin, executable),
        process.platform === "win32"
          ? "@echo off\r\necho wrong pnpm owner 1>&2\r\nexit /b 1\r\n"
          : "#!/bin/sh\necho wrong pnpm owner >&2\nexit 1\n",
        { mode: 0o755 },
      );
    }
    const sourceEnv = {
      HOME: base,
      PNPM_HOME: major === 11 ? path.join(base, "other-home") : pnpmHome,
      PATH: [otherBin, ...(onPath ? [pnpmHome] : [])].join(path.delimiter),
    };
    const runCommand = vi.fn(runCommandWithTimeout);
    const commandOptions = { runCommand, timeoutMs: 1000 };
    const installTarget = await resolveGlobalInstallTarget({
      ...commandOptions,
      manager: "pnpm",
      pkgRoot: packageRoot,
      ...(major === 10 ? { env: sourceEnv } : {}),
    });
    const env = await createGlobalInstallEnv(sourceEnv, installTarget);
    if (major === 11) {
      const result = await validatePnpmIsolatedUpdate({
        ...commandOptions,
        installTarget,
        packageName: "openclaw",
        env,
      });
      expect(result.failedStep).toBeNull();
      expect(result.globalBinDir).toBe(binDir);
      expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([
        [pnpmCommand, "root", "-g"],
        [pnpmCommand, "bin", "-g"],
      ]);
      expect(env.PNPM_HOME).toBe(pnpmHome);
      expect(env.PATH?.split(path.delimiter)).toEqual([binDir, pnpmHome, otherBin]);
      expect(sourceEnv.PATH).toBe(otherBin);
      expect(sourceEnv.PNPM_HOME).toBe(path.join(base, "other-home"));
    } else {
      const runStep = vi.fn(async (step: Parameters<typeof packageUpdateStepResult>[0]) => {
        expect(step.argv[0]).toBe(pnpmCommand);
        expect(step.cwd).toContain(path.join(pnpmHome, ".openclaw-update-native-"));
        return packageUpdateStepResult(step, {
          exitCode: 1,
          stderrTail: "proof stopped before install",
        });
      });
      const result = await runGlobalPackageUpdateSteps({
        ...commandOptions,
        installTarget,
        packageRoot,
        packageName: "openclaw",
        installSpec: "openclaw@2.0.0",
        env,
        runStep,
      });
      expect(result.failedStep?.stderrTail).toBe("proof stopped before install");
      expect(runStep).toHaveBeenCalledOnce();
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(
        JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version,
      ).toBe("1.0.0");
    }
  });
});
