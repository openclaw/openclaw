import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import * as configFlow from "../commands/doctor-config-flow.js";
import { loadGatewayStartupConfigSnapshot } from "../gateway/server-startup-config-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "./doctor-health-contribution-runners.config.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

const actualConfigFlow = await vi.importActual<typeof configFlow>(
  "../commands/doctor-config-flow.js",
);

describe("Doctor with externally managed config", () => {
  useDoctorHealthFixture();

  it.each([false, true])(
    "repairs state while leaving config edits external (invalid=%s)",
    async (invalid) => {
      await withOpenClawTestState(
        {
          scenario: "minimal",
          env: { OPENCLAW_CONFIG_READONLY: "1", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          mocks.emulateNativeInstall = false;
          await state.writeConfig({
            agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
            gateway: { mode: "local", auth: { mode: "none" } },
            plugins: { enabled: false },
            tools: { exec: { safeBins: ["synthetic-filter"] } },
            ...(invalid ? { session: { maintenance: { rotateBytes: 1000000 } } } : {}),
          });
          const original = fs.readFileSync(state.configPath);
          fs.chmodSync(state.configPath, 0o444);
          fs.mkdirSync(state.workspaceDir, { recursive: true });
          fs.writeFileSync(
            path.join(state.workspaceDir, "openclaw-workspace-state.json"),
            JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
          );
          const configSpy = vi
            .spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig")
            .mockImplementation(actualConfigFlow.loadAndMaybeMigrateDoctorConfig);
          mocks.runContributions.mockImplementation(async (ctx) => {
            await runInitialConfigWriteHealth(ctx);
            await runWriteConfigHealth(ctx);
          });
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          try {
            await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
            expect(fs.readFileSync(state.configPath)).toEqual(original);
            expect(fs.existsSync(`${state.configPath}.bak`)).toBe(false);
            expect(runtime.log.mock.calls.flat().join("\n")).toContain('"synthetic-filter": {}');
            expect(
              (await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt,
            ).toBe("2026-07-15T00:00:00.000Z");
            if (invalid) {
              expect(runtime.exit).toHaveBeenCalledWith(1);
              expect(runtime.log.mock.calls.flat().join("\n")).toContain('"rotateBytes": null');
            } else {
              expect(runtime.exit).not.toHaveBeenCalledWith(1);
            }
            const startup = loadGatewayStartupConfigSnapshot({
              minimalTestGateway: false,
              ambientEnvTriggers: "suppress",
              log: { info: vi.fn(), warn: vi.fn() },
            });
            if (invalid) {
              await expect(startup).rejects.toThrow(/read-only config|Invalid config/);
            } else {
              await expect(startup).resolves.toMatchObject({ snapshot: { valid: true } });
            }
          } finally {
            configSpy.mockRestore();
            fs.chmodSync(state.configPath, 0o600);
          }
        },
      );
    },
  );
});
