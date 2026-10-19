import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";

it.each(["EACCES", "EPERM"])(
  "reports npm %s with its directory and owner without retrying",
  async (code) => {
    await withTestDir({ prefix: "openclaw-permission-outcome-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv }: { name: string; argv: string[] }) => ({
        name,
        command: argv.join(" "),
        cwd: base,
        durationMs: 0,
        exitCode: 243,
        stderrTail: `npm error code ${code}\nnpm error syscall rename\nnpm error path ${packageRoot}\nnpm error ${code}: permission denied, rename '${packageRoot}'`,
      }));
      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });
      expect(result.reason).toBe("global-install-permission-denied");
      expect(result.failedStep?.stderrTail).toContain(globalRoot);
      expect(result.failedStep?.stderrTail).toContain(
        process.platform === "win32"
          ? "owner unavailable"
          : `UID ${(await fs.stat(globalRoot)).uid}`,
      );
      expect(result.failedStep?.stderrTail).toContain("rerun `openclaw update`");
      expect(result.failedStep?.failureFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "global-install-permission-denied" }),
        ]),
      );
      expect(runStep).toHaveBeenCalledOnce();
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
    });
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "refuses an unwritable global directory before staging",
  async () => {
    await withTestDir({ prefix: "openclaw-permission-preflight-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      await writePackageRoot(path.join(globalRoot, "openclaw"), "1.0.0");
      const runStep = vi.fn();
      await fs.chmod(globalRoot, 0o555);
      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });
        expect(result.reason).toBe("global-install-permission-denied");
        expect(result.failedStep?.stderrTail).toContain(globalRoot);
        expect(result.failedStep?.stderrTail).toContain("chmod u+rwx");
        expect(runStep).not.toHaveBeenCalled();
        expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
      } finally {
        await fs.chmod(globalRoot, 0o755);
      }
    });
  },
);
