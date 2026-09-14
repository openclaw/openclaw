// Exercise private Doctor convergence through real npm and peer-link owners.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUpdateRehearsalPathEnv } from "../../../infra/update-rehearsal-paths.js";
import { resolvePluginInstallRoots } from "../../../plugins/install-root-context.js";
import { resolveCommandEnv } from "../../../process/exec-spawn.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { convergeDoctorMigrationPlugins } from "./migration-plugin-convergence.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";
import { createDoctorRehearsalWriteGuard } from "./rehearsal-write-scope.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("../../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../process/exec.js")>()),
  runCommandWithTimeout: transport,
}));

function privateEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
}

beforeEach(() => {
  transport.mockReset();
});

describe("private Doctor effect boundaries", () => {
  it("keeps real convergence npm metadata children off an inherited outside cache", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const outside = state.path("original-cache");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "retained"), "original cache");
      const installPath = state.statePath("extensions", "missing-migration");
      const config = {
        agents: { entries: { main: {} } },
        plugins: {
          allow: ["missing-migration"],
          entries: { "missing-migration": { enabled: true } },
          installs: {
            "missing-migration": {
              source: "npm" as const,
              spec: "@fixture/missing-migration@1.0.0",
              installPath,
              version: "1.0.0",
            },
          },
        },
      };
      await state.writeConfig(config);
      const commands: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
      transport.mockImplementation(
        async (argv: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
          commands.push({ argv, env: resolveCommandEnv({ argv, env: options.env }) });
          return {
            code: 1,
            stdout: "",
            stderr: "inert npm transport: registry unavailable",
            signal: null,
            killed: false,
            termination: "exit",
          };
        },
      );
      await withEnvAsync(
        { ...privateEnv(state.stateDir), npm_config_cache: outside, NPM_CONFIG_CACHE: outside },
        async () => {
          await expect(
            convergeDoctorMigrationPlugins({ env: process.env, onNote: () => {} }),
          ).rejects.toThrow();
          const npm = commands.filter(({ argv }) => argv[0] === "npm");
          expect(npm.some(({ argv }) => argv[1] === "view")).toBe(true);
          for (const { env } of npm) {
            expect(env.npm_config_cache).toBe(path.join(state.stateDir, "cache", "npm"));
            expect(env.NPM_CONFIG_CACHE).toBe(env.npm_config_cache);
          }
          expect(process.env.npm_config_cache).toBe(outside);
          expect(process.env.NPM_CONFIG_CACHE).toBe(outside);
        },
      );
      expect(fs.readdirSync(outside)).toEqual(["retained"]);
      expect(fs.readFileSync(path.join(outside, "retained"), "utf8")).toBe("original cache");
    });
  });

  it.each(["node_modules", "projects"] as const)(
    "refuses unindexed managed packages behind a nested %s symlink",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const env = privateEnv(state.stateDir);
        const roots = resolvePluginInstallRoots({ ...state.env, ...env });
        const outside = state.path("original-npm");
        const packageDir =
          kind === "projects"
            ? path.join(outside, "project", "node_modules", "orphan")
            : path.join(outside, "orphan");
        fs.mkdirSync(packageDir, { recursive: true });
        const manifest = JSON.stringify({
          name: "orphan",
          version: "1.0.0",
          peerDependencies: { openclaw: "*" },
        });
        fs.writeFileSync(path.join(packageDir, "package.json"), manifest);
        fs.mkdirSync(roots.npmDir, { recursive: true });
        fs.symlinkSync(outside, path.join(roots.npmDir, kind), "junction");
        const config = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
        await state.writeConfig(config);
        await withEnvAsync(env, async () => {
          await expect(
            runPostCorePluginConvergence({
              cfg: config,
              env: process.env,
              baselineInstallRecords: {},
              beforePersistentEffect: createDoctorRehearsalWriteGuard(process.env),
            }),
          ).rejects.toThrow("escapes the update rehearsal");
        });
        expect(transport).not.toHaveBeenCalled();
        expect(fs.readdirSync(packageDir)).toEqual(["package.json"]);
        expect(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).toBe(manifest);
        expect(fs.lstatSync(path.join(roots.npmDir, kind)).isSymbolicLink()).toBe(true);
      });
    },
  );
});
