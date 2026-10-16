import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { testApi as configGuardTestApi } from "../cli/program/config-guard.js";
import { registerPreActionHooks } from "../cli/program/preaction.js";
import * as startupPreflight from "../commands/startup-config-preflight.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import * as configObservation from "../config/io.observe.js";
import { isVerbose, setVerbose } from "../globals.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveNodeService } from "./node-service.js";
import { resolveGatewayService } from "./service.js";
import { mockSystemAccountHome } from "./service.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  { kind: "gateway", resolve: resolveGatewayService, stateName: ".openclaw" },
  { kind: "node", resolve: resolveNodeService, stateName: "node-state" },
])(
  "guards every $kind mutation when config was written by a newer OpenClaw",
  async ({ kind, resolve, stateName }) => {
    mockSystemAccountHome();
    const tempHome = await makeTempWorkspace("openclaw-service-future-config-");
    const stateDir = path.join(tempHome, stateName);
    const configPath = path.join(stateDir, "openclaw.json");
    const envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "NODE_NO_WARNINGS",
      "OPENCLAW_HIDE_BANNER",
    ]);
    const originalArgv = process.argv;
    const originalTitle = process.title;
    const originalVerbose = isVerbose();
    const observation = vi.spyOn(configObservation, "observeConfigSnapshot");
    const preflight = vi.spyOn(startupPreflight, "runStartupConfigPreflight");
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            meta: {
              lastTouchedVersion: "9999.1.1",
            },
          },
          null,
          2,
        ),
      );
      process.env.OPENCLAW_HIDE_BANNER = "1";
      process.env.HOME = tempHome;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const service = resolve();
      const args = {
        env: process.env,
        stdout: process.stdout,
        programArguments: ["openclaw", kind, "run"],
      };
      for (const action of ["install", "uninstall", "start", "stop", "restart", "stage"] as const) {
        let run = async () => {
          await service[action](args);
        };
        if (kind === "node" && action !== "stage") {
          configGuardTestApi.resetConfigGuardStateForTests();
          const program = new Command().name("openclaw");
          program.command("node").command(action).action(run);
          registerPreActionHooks(program, "test");
          process.argv = ["node", "openclaw", "node", action];
          run = async () => {
            await program.parseAsync(process.argv);
          };
        }
        await expect(run()).rejects.toThrow(`the ${kind} service because this OpenClaw binary`);
        expect(observation).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
      }
    } finally {
      process.argv = originalArgv;
      process.title = originalTitle;
      setVerbose(originalVerbose);
      configGuardTestApi.resetConfigGuardStateForTests();
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  },
);
