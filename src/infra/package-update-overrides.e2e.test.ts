import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";

const exec = promisify(execFile);
const readText = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const writeText = (root: string, file: string, text: string) =>
  fs.writeFile(path.join(root, file), text);
const writeJson = (root: string, file: string, value: unknown) =>
  writeText(root, file, JSON.stringify(value));
const script = (message: string) =>
  `#!/usr/bin/env node\nconsole.log(${JSON.stringify(message)});\n`;
const scenarios = [
  "late replay",
  "preserve only",
  "unchanged",
  "legacy",
  "conflict",
  "unsafe topology",
  "install failure",
  "doctor failure",
  "late recovery refusal",
] as const;

it.each(scenarios)(
  "local overrides through real npm package updates: %s",
  (scenario) =>
    withTestDir({ prefix: "openclaw-local-overrides-e2e-" }, async (base) => {
      const env = {
        ...process.env,
        HOME: path.join(base, "home"),
        npm_config_cache: path.join(base, "cache"),
        npm_config_userconfig: path.join(base, "npmrc"),
        OPENCLAW_STATE_DIR: path.join(base, "state"),
      };
      await fs.mkdir(env.HOME);
      await fs.writeFile(env.npm_config_userconfig, "");
      const run = (command: string, args: string[], cwd = base) =>
        exec(command, args, { cwd, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
      const pristine = script("upstream");
      const local = script("operator override");
      const targetSource = scenario === "conflict" ? script("new upstream") : pristine;
      async function pack(version: string, source: string, legacy = false) {
        const root = path.join(base, version);
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await writeJson(root, "package.json", {
          name: "openclaw",
          version,
          type: "module",
          files: ["dist"],
          bin: { openclaw: "dist/index.js" },
        });
        await fs.writeFile(path.join(root, "dist/index.js"), source, { mode: 0o755 });
        await writePackageDistInventory(root);
        if (legacy) {
          await fs.rm(path.join(root, "dist/postinstall-content-inventory.json"));
          await writeJson(root, "dist/postinstall-inventory.json", ["dist/index.js"]);
        }
        await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", base], root);
        return path.join(base, `openclaw-${version}.tgz`);
      }
      const old = await pack("2026.9.3", pristine, scenario === "legacy");
      const candidate = await pack("2026.9.4", targetSource);
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(
        prefix,
        process.platform === "win32" ? "node_modules" : "lib/node_modules",
      );
      const root = path.join(globalRoot, "openclaw");
      await run("npm", [
        "install",
        "-g",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        old,
      ]);
      if (scenario !== "unchanged") {
        await writeText(root, "dist/index.js", local);
        await writeText(root, "dist/local.js", "local payload\n");
      }
      const outside = path.join(base, "outside");
      if (scenario === "unsafe topology") {
        await fs.mkdir(outside);
        await writeText(outside, "untouched", "outside\n");
        await fs.symlink(
          outside,
          path.join(root, "dist/redirect"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const late =
        scenario === "late replay" ||
        scenario === "preserve only" ||
        scenario === "late recovery refusal";
      const doctorFails = scenario === "doctor failure" || scenario === "late recovery refusal";
      let activationEntered = false;
      let transaction: PackageUpdateTransaction | undefined;
      const npmVersion = (await run("npm", ["--version"])).stdout.trim();
      const [major = 0, minor = 0] = npmVersion.split(".").map(Number);
      const lifecyclePolicy =
        major >= 12
          ? "allow-scripts"
          : major === 11 && minor >= 16
            ? "allow-scripts-advisory"
            : "unflagged";
      const command = async (argv: string[], cwd?: string) => {
        const [executable, ...args] = argv;
        if (!executable) {
          throw new Error("Fixture command must contain an executable");
        }
        try {
          return { ...(await run(executable, args, cwd)), code: 0 };
        } catch (error) {
          const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
          return {
            code: typeof failure.code === "number" ? failure.code : 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? String(error),
          };
        }
      };
      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "npm",
          command: "npm",
          globalRoot,
          packageRoot: root,
          npmOwner: { version: npmVersion, lifecyclePolicy },
        },
        installSpec: scenario === "install failure" ? path.join(base, "missing.tgz") : candidate,
        packageName: "openclaw",
        packageRoot: root,
        requirePackageReplacement: true,
        env,
        timeoutMs: 60_000,
        localOverrides: { reapply: scenario !== "preserve only", env },
        runCommand: (argv, options) => command(argv, options.cwd),
        runStep: async ({ name, argv, cwd }) => {
          const started = Date.now();
          const value = await command(argv, cwd);
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? base,
            durationMs: Date.now() - started,
            exitCode: value.code,
            stdoutTail: value.stdout,
            stderrTail: value.stderr,
          };
        },
        beforeActivate: async () => {
          activationEntered = true;
          if (late) {
            await writeText(root, "dist/late.js", "late payload\n");
          }
        },
        onTransaction: (value) => {
          transaction = value;
        },
        postVerifyStep: async (packageRoot) => ({
          name: "fixture doctor",
          command: "fixture doctor",
          cwd: packageRoot,
          durationMs: 0,
          exitCode: doctorFails ? 1 : 0,
          stderrTail: doctorFails ? "injected doctor failure" : null,
        }),
      });
      if (scenario === "unsafe topology" || scenario === "install failure") {
        expect(result.failedStep).not.toBeNull();
        expect(activationEntered).toBe(false);
        expect(await readText(root, "dist/index.js")).toBe(local);
        if (scenario === "unsafe topology") {
          expect(await readText(outside, "untouched")).toBe("outside\n");
        }
        return;
      }
      expect(transaction).toBeDefined();
      if (doctorFails) {
        expect(result.failedStep?.name).toBe("fixture doctor");
        expect(result.recovery.serviceRestartSafe).toBe(false);
        const rollback = await transaction!.rollback(() => {});
        expect(rollback.exitCode).toBe(scenario === "doctor failure" ? 0 : 1);
        const completion = await transaction!.complete({ activationVerified: false }, () => {});
        if (scenario === "late recovery refusal") {
          expect(completion?.exitCode).toBe(1);
          expect(await fs.stat(transaction!.backupRoot)).toBeDefined();
          expect(await readText(result.localOverrides!.recoveryDir!, "files/dist/late.js")).toBe(
            "late payload\n",
          );
        } else {
          expect(await readText(root, "package.json")).toContain("2026.9.3");
          expect(await readText(root, "dist/index.js")).toBe(local);
        }
        return;
      }
      expect(result.failedStep).toBeNull();
      await transaction!.complete({ activationVerified: true }, () => {});
      const replayed = scenario === "late replay";
      expect((await run(process.execPath, [path.join(root, "dist/index.js")])).stdout.trim()).toBe(
        replayed ? "operator override" : scenario === "conflict" ? "new upstream" : "upstream",
      );
      if (scenario === "unchanged") {
        expect(result.localOverrides?.status).toBe("none");
        expect(result.localOverrides?.recoveryDir).toBeUndefined();
      } else {
        expect(result.localOverrides?.status).toBe(
          replayed ? "applied" : scenario === "conflict" ? "conflict" : "preserved",
        );
        expect(result.localOverrides?.applied).toBe(replayed ? 3 : 0);
        const saved = result.localOverrides!.recoveryDir!;
        expect(await readText(saved, "files/dist/index.js")).toBe(local);
        if (late) {
          expect(await readText(saved, "files/dist/late.js")).toBe("late payload\n");
        }
        expect(
          result.steps.some(
            (step) =>
              step.name === "local-package-overrides" && step.advisory?.message.includes(saved),
          ),
        ).toBe(true);
      }
      expect(await fs.stat(transaction!.backupRoot).catch(() => null)).toBeNull();
    }),
  120_000,
);
