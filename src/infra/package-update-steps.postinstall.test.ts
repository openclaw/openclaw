import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmUpdateOptions,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { runStep } from "./update-runner-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { refused: true, stream: "stderr", attempts: 1 },
  { refused: true, stream: "stdout", attempts: 1 },
  { refused: false, stream: "stderr", attempts: 2 },
])("bounds postinstall retry (refused=$refused, stream=$stream)", async (scenario) => {
  const base = dirs.make("package-postinstall-refusal-");
  const globalRoot = path.join(base, "prefix/lib/node_modules");
  const packageRoot = path.join(globalRoot, "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  const message = scenario.refused ? "schema refused" : "optional build failed";
  const installs: string[][] = [];
  const result = await runGlobalPackageUpdateSteps({
    ...createNpmUpdateOptions(globalRoot),
    runStep: (options) =>
      runStep({
        ...options,
        cwd: options.cwd ?? base,
        stepIndex: 0,
        totalSteps: 1,
        runCommand: async (argv) => {
          installs.push(argv);
          const stagedRoot = path.join(stagedNpmPrefix(argv), "lib/node_modules/openclaw");
          for (const relativePath of [
            "scripts/postinstall-bundled-plugins.mjs",
            "scripts/lib/package-lifecycle-marker.mjs",
            "scripts/lib/fs-safe-prebuild.mjs",
            "scripts/windows-cmd-helpers.mjs",
          ]) {
            const destination = path.join(stagedRoot, relativePath);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(new URL(`../../${relativePath}`, import.meta.url), destination);
          }
          await fs.writeFile(path.join(stagedRoot, "package.json"), '{"type":"module"}\n');
          const guardDir = path.join(stagedRoot, "dist/commands");
          await fs.mkdir(guardDir, { recursive: true });
          await fs.writeFile(
            path.join(guardDir, "doctor-update-schema-guard.js"),
            `export async function preflightUpdatePackageLifecycle() {
              throw Object.assign(new Error(${JSON.stringify(message)}), {
                code: ${JSON.stringify(scenario.refused ? "update-schema-bump-unfenced" : "1")}
              });
            }`,
          );
          const script = path.join(stagedRoot, "scripts/postinstall-bundled-plugins.mjs");
          const launch = `Object.defineProperty(process, "platform", { value: "win32" });
              process.argv[1] = ${JSON.stringify(script)};
              await import(${JSON.stringify(pathToFileURL(script).href)});`;
          const child = spawnSync(process.execPath, ["--input-type=module", "--eval", launch], {
            cwd: stagedRoot,
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: path.join(base, "state"),
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
            },
          });
          expect(child.error).toBeUndefined();
          expect(child.status, child.stderr).toBe(1);
          return {
            code: child.status,
            stdout: scenario.stream === "stdout" ? child.stderr : child.stdout,
            stderr: `npm error code 1\n${scenario.stream === "stderr" ? child.stderr : ""}`,
          };
        },
      }),
  });
  expect(installs).toHaveLength(scenario.attempts);
  expect(result.steps.map((step) => step.name)).toEqual(
    scenario.refused ? ["package-install"] : ["package-install", "package-install-omit-optional"],
  );
  expect(installs.flat().includes("--omit=optional")).toBe(!scenario.refused);
  const tail = result.failedStep?.[scenario.stream === "stdout" ? "stdoutTail" : "stderrTail"];
  expect(tail).toContain(message);
  if (scenario.refused) {
    expect(tail).toContain("[update-schema-bump-unfenced]");
  }
  expect(result.recovery.serviceRestartSafe).toBe(true);
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"1.0.0"',
  );
});
