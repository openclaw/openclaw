import fs from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runWriteConfigHealth } from "../../../flows/doctor-health-contribution-runners.config.js";
import { runReleaseConfiguredPluginInstallsHealth } from "../../../flows/doctor-health-contribution-runners.state.js";
import { createDoctorHealthFlowContext } from "../../../flows/doctor-health-contributions.test-support.js";
import { readConfigMachineState } from "../../../state/config-machine-state.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../../version.js";

const mocks = vi.hoisted(() => ({
  repair:
    vi.fn<
      typeof import("./missing-configured-plugin-install.js").repairMissingPluginInstallsForIds
    >(),
}));

// Only external package installation is replaced; selection, Doctor's caller,
// metadata handling and the canonical config writer are the real owners.
vi.mock("./missing-configured-plugin-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./missing-configured-plugin-install.js")>()),
  repairMissingPluginInstallsForIds: mocks.repair,
}));

const updateEnv = {
  OPENCLAW_UPDATE_IN_PROGRESS: "1",
  OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
  OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
  OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
};

beforeEach(() => {
  mocks.repair.mockReset().mockResolvedValue({ changes: [], warnings: [], records: {} });
});

function createContext(state: OpenClawTestState, cfg: OpenClawConfig) {
  const ctx = createDoctorHealthFlowContext({
    cfg,
    cfgForPersistence: structuredClone(cfg),
    configPath: state.configPath,
    configResult: {
      cfg,
      shouldWriteConfig: false,
      sourceLastTouchedVersion: cfg.meta?.lastTouchedVersion,
    },
    env: state.env,
  });
  ctx.prompter.shouldRepair = true;
  return ctx;
}

it.each(["absent", "empty", "2026.9.4"])(
  "preserves authored config and metadata after empty release backfill (%s)",
  async (kind) => {
    await withOpenClawTestState(
      { label: "release-backfill-noop", env: updateEnv },
      async (state) => {
        const cfg: OpenClawConfig =
          kind === "2026.9.4"
            ? { meta: { lastTouchedVersion: "2026.9.4" }, gateway: { port: 18791 } }
            : {};
        const raw =
          kind === "absent"
            ? undefined
            : `// Operator formatting stays intact.\n${JSON.stringify(cfg)}\n`;
        if (raw !== undefined) {
          await fs.writeFile(state.configPath, raw);
        }
        const timestamp = readConfigMachineState<string>("config.lastTouchedAt");
        const ctx = createContext(state, cfg);

        await runReleaseConfiguredPluginInstallsHealth(ctx);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });

        expect.soft(ctx.cfg).toEqual(cfg);
        expect.soft(readConfigMachineState<string>("config.lastTouchedAt")).toBe(timestamp);
        expect(mocks.repair).not.toHaveBeenCalled();
        if (raw === undefined) {
          await expect(fs.readFile(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
        }
      },
    );
  },
);

const configuredCases: Array<{ kind: "plugin" | "channel"; id: string; cfg: OpenClawConfig }> = [
  { kind: "plugin", id: "discord", cfg: { plugins: { entries: { discord: { enabled: true } } } } },
  {
    kind: "channel",
    id: "whatsapp",
    cfg: { channels: { whatsapp: { allowFrom: ["+15555550123"] } } },
  },
];

it.each(configuredCases)(
  "persists the required completion write for configured $kind work",
  async ({ kind, id, cfg }) => {
    await withOpenClawTestState(
      { label: "release-backfill-work", env: updateEnv },
      async (state) => {
        await state.writeConfig(cfg);
        mocks.repair.mockResolvedValue({
          changes: [`Installed configured ${kind} ${id}.`],
          warnings: [],
          records: {},
        });
        const ctx = createContext(state, cfg);

        await runReleaseConfiguredPluginInstallsHealth(ctx);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });

        expect(mocks.repair).toHaveBeenCalledOnce();
        expect(mocks.repair).toHaveBeenCalledWith(
          expect.objectContaining({
            [kind === "plugin" ? "pluginIds" : "channelIds"]: expect.arrayContaining([id]),
          }),
        );
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
          ...cfg,
          meta: { lastTouchedVersion: VERSION },
          wizard: { lastRunVersion: VERSION, lastRunCommand: "doctor" },
        });
      },
    );
  },
);

it("still commits a genuine config repair and first-write privacy defaults after empty backfill", async () => {
  await withOpenClawTestState(
    { label: "release-backfill-real-repair", env: updateEnv },
    async (state) => {
      const ctx = createContext(state, { gateway: { mode: "local" } });
      ctx.configResult.shouldWriteConfig = true;

      await runReleaseConfiguredPluginInstallsHealth(ctx);
      await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });

      expect(mocks.repair).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
        gateway: { mode: "local" },
        meta: { lastTouchedVersion: VERSION },
        wizard: { lastRunVersion: VERSION, lastRunCommand: "doctor" },
        plugins: {
          entries: {
            anthropic: { config: { sessionCatalog: { enabled: false } } },
            codex: { config: { sessionCatalog: { enabled: false } } },
          },
        },
      });
      expect(ctx.configResultWriteCommitted).toBe(true);
    },
  );
});
