import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { deleteAgentConfigEntry } from "./agents-config-mutations.js";

it("returns the deleted target when the roster key differs in case from the agent id", async () => {
  await withOpenClawTestState({ label: "agent-delete-mixed-case-key" }, async (state) => {
    await state.writeConfig({
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: state.path("ws-main") },
          Ops: { workspace: state.path("ws-ops") },
        },
      },
    });

    const committed = await deleteAgentConfigEntry({ agentId: "ops" });

    expect(committed.result).toEqual({
      workspaceDir: state.path("ws-ops"),
      agentDir: expect.any(String),
      sessionsDir: expect.any(String),
      removedBindings: 0,
    });
    const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(Object.keys(persisted.agents.entries)).toEqual(["main"]);
  });
});
