import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runBuiltRuntime,
  runSourceRuntime,
} from "../commands/doctor-config-preflight.process.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { getFreePort } from "../test-utils/ports.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";

const tempDirs = createFixtureLifetime();
afterEach(() => tempDirs.cleanup());

async function createSagCliFixture(binaryPresent: boolean, enabled?: boolean) {
  const root = tempDirs.createTempDir("openclaw-sag-cli-");
  const configPath = path.join(root, "openclaw.json");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  if (binaryPresent) {
    // Readiness checks executable access; credentials are resolved only when sag runs.
    fs.writeFileSync(path.join(binDir, process.platform === "win32" ? "sag.cmd" : "sag"), "", {
      mode: 0o755,
    });
  }
  const config = {
    gateway: {
      mode: "local",
      port: await getFreePort(),
      auth: { mode: "token", token: "sag-fixture-token" },
    },
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    skills: {
      allowBundled: ["sag"],
      ...(enabled === undefined ? {} : { entries: { sag: { enabled } } }),
    },
    plugins: { enabled: false },
    logging: { file: path.join(root, "openclaw.log") },
  } satisfies OpenClawConfig;
  fs.writeFileSync(configPath, JSON.stringify(config));

  const entryPath = fileURLToPath(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli));
  const source = /\.[cm]?ts$/u.test(entryPath);
  const runtimeRoot = source
    ? createSourceRuntime(root)
    : createBuiltRuntime(root, path.dirname(entryPath));
  fs.symlinkSync(
    path.resolve("skills"),
    path.join(runtimeRoot, "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );
  // No host credentials or Gateway endpoint enter this stopped-Gateway fixture.
  const env: NodeJS.ProcessEnv = {
    PATH: binDir,
    PATHEXT: ".CMD",
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: root,
    USERPROFILE: root,
    NODE_DISABLE_COMPILE_CACHE: "1",
    ESBUILD_WORKER_THREADS: "0",
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HIDE_BANNER: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_PATH_BOOTSTRAPPED: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_TEST_FAST: "1",
  };
  const cli = async (args: string[]) => {
    const result = source
      ? await tempDirs.track(
          runSourceRuntime(
            runtimeRoot,
            env,
            [path.join(runtimeRoot, "src", "entry.ts"), ...args],
            60_000,
            4 * 1024 * 1024,
          ),
        )
      : await tempDirs.track(runBuiltRuntime(runtimeRoot, env, args, 60_000, 4 * 1024 * 1024));
    const output = `${result.stderr}\n${result.stdout}`;
    expect(result.signal, output).toBeNull();
    expect(result.code, output).toBe(0);
    return result.stdout;
  };
  return { cli, configPath };
}

describe("bundled sag through the registered CLI", () => {
  it.each([true, false])(
    "requires the binary without requiring credential environment variables (installed: %s)",
    async (binaryPresent) => {
      const { cli } = await createSagCliFixture(binaryPresent);
      const status = JSON.parse(await cli(["skills", "info", "sag", "--json"]));

      expect(status).toMatchObject({
        name: "sag",
        source: "openclaw-bundled",
        bundled: true,
        primaryEnv: "ELEVENLABS_API_KEY",
        requirements: { bins: ["sag"], env: [] },
        missing: { bins: binaryPresent ? [] : ["sag"], env: [] },
        eligible: binaryPresent,
        modelVisible: binaryPresent,
        commandVisible: binaryPresent,
      });
    },
    90_000,
  );

  it.each([undefined, true])(
    "doctor --fix preserves an installed sag skill's saved enable flag (%s) with the Gateway stopped",
    async (enabled) => {
      const { cli, configPath } = await createSagCliFixture(true, enabled);
      const output = await cli([
        "doctor",
        "--fix",
        "--non-interactive",
        "--no-workspace-suggestions",
      ]);

      expect(output).toContain("Doctor complete.");
      const saved: OpenClawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(saved.skills?.entries?.sag?.enabled, output).toBe(enabled);
    },
    90_000,
  );
});
