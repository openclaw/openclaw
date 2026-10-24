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
const scenarios = ["unchanged", "legacy", "late recovery refusal"] as const;

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
      const candidate = await pack("2026.9.4", pristine);
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
      const doctorFails = scenario === "late recovery refusal";
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
        installSpec: candidate,
        packageName: "openclaw",
        packageRoot: root,
        requirePackageReplacement: true,
        env,
        timeoutMs: 60_000,
        localOverrides: { reapply: true, env },
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
          if (doctorFails) {
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
      expect(transaction).toBeDefined();
      if (doctorFails) {
        expect(result).toMatchObject({
          failedStep: { name: "fixture doctor" },
          recovery: { serviceRestartSafe: false },
        });
        await expect(transaction!.rollback(() => {})).resolves.toMatchObject({ exitCode: 1 });
        await expect(
          transaction!.complete({ activationVerified: false }, () => {}),
        ).resolves.toMatchObject({ exitCode: 1 });
        expect(await fs.stat(transaction!.backupRoot)).toBeDefined();
        expect(await readText(result.localOverrides!.recoveryDir!, "files/dist/late.js")).toBe(
          "late payload\n",
        );
        return;
      }
      expect(result.failedStep).toBeNull();
      await transaction!.complete({ activationVerified: true }, () => {});
      expect((await run(process.execPath, [path.join(root, "dist/index.js")])).stdout.trim()).toBe(
        "upstream",
      );
      if (scenario === "unchanged") {
        expect(result.localOverrides?.status).toBe("none");
        expect(result.localOverrides?.recoveryDir).toBeUndefined();
      } else {
        expect(result.localOverrides).toMatchObject({ status: "preserved", applied: 0 });
        const saved = result.localOverrides!.recoveryDir!;
        expect(await readText(saved, "files/dist/index.js")).toBe(local);
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
