import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { activateGatewaySetupInference } from "./system-agent-execution.js";

// The verified connection/application receipt is the input to this boundary.
// Agent creation, workspace seeding and config persistence remain real.
vi.mock("../../system-agent/setup-inference.js", async (original) => {
  const actual = await original<typeof import("../../system-agent/setup-inference.js")>();
  return {
    ...actual,
    activateSetupInference: vi.fn<typeof actual.activateSetupInference>(async (params) => {
      params.onActivationCompletion?.(async () => false);
      return {
        ok: true,
        modelRef: "fixture/model",
        latencyMs: 1,
        lines: [],
        ...(params.modelTarget ? { modelTarget: params.modelTarget } : {}),
      };
    }),
  };
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

it.each(["fresh", "existing", "utility"] as const)(
  "finishes verified %s setup without replaying Gateway or tool defaults",
  async (kind) => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const workspace = path.join(home, "workspace");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const authored = {
        gateway: { mode: "local", auth: { mode: "token", token: "synthetic-test-token" } },
        tools: { profile: "coding" },
        plugins: { slots: { memory: "none" } },
        agents: {
          defaults: { workspace, model: "fixture/model" },
          ...(kind === "existing" ? { entries: { helper: { workspace } } } : {}),
        },
      };
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(authored));
      resetConfigRuntimeState();
      const activate = (agentId?: string) =>
        activateGatewaySetupInference({
          kind: "existing-model",
          surface: "gateway",
          runtime: defaultRuntime,
          completeFirstAgent: true,
          ...(agentId ? { agentId } : {}),
          ...(kind === "utility" ? { modelTarget: "utility" as const } : {}),
        });
      if (kind === "fresh") {
        await expect(activate("other")).rejects.toThrow("requested agent");
      }
      const result = await activate();
      expect(result.ok).toBe(true);
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.sourceConfig.tools).toEqual(authored.tools);
      expect(snapshot.sourceConfig.gateway).toMatchObject(authored.gateway);
      if (kind === "utility") {
        expect(result).not.toHaveProperty("firstAgent");
        expect(snapshot.sourceConfigBeforeMigrations?.agents).not.toHaveProperty("entries");
        return;
      }
      const agentId = kind === "existing" ? "helper" : "main";
      expect(result).toMatchObject({
        firstAgent: {
          agentId,
          sessionKey: "agent:" + agentId + ":main",
          bootstrapPending: kind === "fresh",
        },
      });
      expect(Object.keys(snapshot.sourceConfig.agents?.entries ?? {})).toEqual([agentId]);
      if (kind === "fresh") {
        expect(await fs.readFile(path.join(workspace, "BOOTSTRAP.md"), "utf8")).toContain(
          "The user's request always comes first.",
        );
        expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).not.toContain(
          "- Name: main",
        );
      }
      const before = await fs.readFile(configPath, "utf8");
      expect(await activate()).toMatchObject({
        firstAgent: { agentId, sessionKey: "agent:" + agentId + ":main" },
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
    });
  },
);
