// Regression: mixed-case roster keys must return their deletion target.
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { deleteAgentConfigEntry } from "./agents-config-mutations.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["ops", "Ops"])(
  "returns the mixed-case roster entry as the deletion target (request: %s)",
  async (agentId) => {
    await withOpenClawTestState({ prefix: "openclaw-agent-delete-case-" }, async (state) => {
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: state.workspaceDir },
            Ops: { workspace: state.path("ws-ops") },
          },
        },
      });
      state.applyEnv();

      const validate = vi.fn();
      const { nextConfig, result } = await deleteAgentConfigEntry({ agentId, validate });

      expect(validate).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "Ops", workspace: state.path("ws-ops") }),
      );
      expect(result).toMatchObject({
        workspaceDir: state.path("ws-ops"),
        agentDir: state.agentDir("ops"),
        sessionsDir: state.sessionsDir("ops"),
      });
      expect(nextConfig.agents?.entries).not.toHaveProperty("Ops");
      expect(nextConfig.agents?.entries).toHaveProperty("main");
    });
  },
);
