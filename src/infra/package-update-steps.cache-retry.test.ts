import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { createNpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { manager: "npm", code: "ETARGET", spec: "file-type@22.1.1", repaired: true, attempts: 2 },
  { manager: "npm", code: "ETARGET", spec: "file-type@22.1.1", repaired: false, attempts: 2 },
  { manager: "npm", code: "E404", spec: "@example/dependency@1.0.0", repaired: true, attempts: 2 },
  { manager: "npm", code: "E404", spec: "@example/dependency@*", repaired: true, attempts: 2 },
  { manager: "npm", code: "EINTEGRITY", spec: "file-type@22.1.1", repaired: true, attempts: 2 },
  { manager: "npm", code: "ETARGET", spec: "openclaw@2.0.0", repaired: false, attempts: 1 },
  { manager: "npm", code: "E404", spec: "openclaw@2.0.0", repaired: false, attempts: 1 },
  { manager: "npm", code: "EINTEGRITY", spec: "", repaired: false, attempts: 1 },
  {
    manager: "npm",
    code: "ETARGET",
    spec: "https://private.invalid/package",
    repaired: false,
    attempts: 1,
  },
  { manager: "npm", code: "ECONNRESET", spec: "", repaired: false, attempts: 2 },
  { manager: "bun", code: "ETARGET", spec: "file-type@22.1.1", repaired: true, attempts: 2 },
  { manager: "bun", code: "ETARGET", spec: "openclaw@2.0.0", repaired: false, attempts: 1 },
] as const)(
  "bounds $manager $code retry for $spec (repaired=$repaired)",
  async ({ manager, code, spec, repaired, attempts }) => {
    const base = dirs.make("package-cache-retry-");
    const globalRoot =
      manager === "npm"
        ? resolveNpmGlobalPrefixLayoutFromPrefix(base).globalRoot
        : path.join(base, "global", "node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    await writePackageRoot(packageRoot, "1.0.0");
    const stderr =
      manager === "bun"
        ? `error: No version matching "${spec.split("@")[1]}" found for specifier "${spec.split("@")[0]}" (but package exists)`
        : [
            `npm error code ${code}`,
            ...(spec
              ? [
                  code === "ETARGET"
                    ? `npm error notarget No matching version found for ${spec}.`
                    : code === "E404"
                      ? `npm error 404 '${spec}' is not in this registry.`
                      : `npm warn tarball tarball data for ${spec} (sha512-synthetic) seems to be corrupted. Trying again.`,
                ]
              : []),
          ].join("\n");
    const installs: { argv: string[]; root: string }[] = [];
    const command = vi.fn(async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      const stageRoot =
        manager === "npm"
          ? resolveNpmGlobalPrefixLayoutFromPrefix(prefix!).globalRoot
          : path.join(options.env!.BUN_INSTALL_GLOBAL_DIR!, "node_modules");
      installs.push({ argv, root: stageRoot });
      if (installs.length === 1 || !repaired) {
        return { code: 1, stdout: "", stderr };
      }
      await writePackageRoot(path.join(stageRoot, "openclaw"), "2.0.0");
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await runGlobalPackageUpdateSteps({
      installTarget:
        manager === "npm"
          ? createNpmTarget(globalRoot)
          : { manager, command: manager, globalRoot, packageRoot },
      packageName: "openclaw",
      installSpec: "openclaw@2.0.0",
      timeoutMs: 1000,
      env: {
        BUN_INSTALL_GLOBAL_DIR: path.dirname(globalRoot),
        BUN_INSTALL_BIN: path.join(base, "bin"),
      },
      runCommand: async () => ({ code: 0, stdout: path.join(base, "bin"), stderr: "" }),
      runStep: async (options) =>
        await runStep({
          ...options,
          cwd: options.cwd ?? base,
          runCommand: command,
          stepIndex: 0,
          totalSteps: 1,
        }),
    });
    expect(installs).toHaveLength(attempts);
    const refresh = attempts === 2 && code !== "ECONNRESET";
    expect(
      installs
        .flatMap(({ argv }) => argv)
        .filter((arg) => arg === "--prefer-online" || arg === "--no-cache"),
    ).toEqual(refresh ? [manager === "npm" ? "--prefer-online" : "--no-cache"] : []);
    expect(installs.flatMap(({ argv }) => argv).includes("--omit=optional")).toBe(
      code === "ECONNRESET",
    );
    if (attempts === 2) {
      expect(installs[1]!.root).not.toBe(installs[0]!.root);
      await expect(fs.access(installs[0]!.root)).rejects.toThrow();
      expect(result.steps[1]?.name).toBe(
        refresh ? "package-install-prefer-online" : "package-install-omit-optional",
      );
    }
    expect(result.failedStep === null).toBe(repaired);
    expect(result.afterVersion).toBe(repaired ? "2.0.0" : null);
    expect(result.recovery.serviceRestartSafe).toBe(true);
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      `"version":"${repaired ? "2.0.0" : "1.0.0"}"`,
    );
    const warnings = updateRunWarningMessages(result.steps.flatMap(updateRunStepsFromResultStep));
    expect(
      warnings.some((message) => message.includes(`Repaired stale package cache for ${spec}`)),
    ).toBe(repaired);
  },
);
