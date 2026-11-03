import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

it("keeps pending deletion targets stable across config writers while allowing other edits", async () => {
  await withOpenClawTestState({ label: "config-pending-agent-deletion" }, async (state) => {
    const original: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: state.workspaceDir },
        entries: { keeper: {}, worker: {} },
      },
    };
    await state.writeConfig(original);
    const originalBytes = await fs.readFile(state.configPath, "utf8");
    beginAgentDeletionJournal({
      agentId: "worker",
      operationId: "pending-deletion",
      agentDir: state.agentDir("worker"),
      workspaceDir: resolveAgentWorkspaceDir(original, "worker"),
      sessionsDir: state.sessionsDir("worker"),
      deleteFiles: true,
      phase: "draining",
    });
    const io = createConfigIO({ env: state.env, configPath: state.configPath, observe: false });
    const candidates: OpenClawConfig[] = [
      {
        ...original,
        agents: {
          ...original.agents,
          entries: { keeper: {}, worker: { workspace: state.path("moved") } },
        },
      },
      {
        ...original,
        agents: { ...original.agents, defaults: { workspace: state.path("moved-default") } },
      },
      {
        ...original,
        agents: {
          ...original.agents,
          entries: { keeper: {}, worker: { agentDir: state.path("moved-agent") } },
        },
      },
      {
        ...original,
        session: { store: state.path("moved-sessions", "{agentId}", "sessions.json") },
      },
    ];
    for (const candidate of candidates) {
      await expect(io.writeConfigFile(candidate)).rejects.toThrow(
        /Agent "worker" deletion cleanup is still pending/,
      );
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
    }
    await io.writeConfigFile({
      ...original,
      agents: {
        ...original.agents,
        entries: { keeper: {}, worker: { name: "Renamed", model: "openai/gpt-4.1" } },
      },
    });
    expect((await io.readConfigFileSnapshot()).config.agents?.entries?.worker).toMatchObject({
      name: "Renamed",
      model: "openai/gpt-4.1",
    });
    const removed: OpenClawConfig = {
      ...original,
      agents: { ...original.agents, entries: { keeper: {} } },
    };
    await io.writeConfigFile(removed, { allowedAgentRosterRemovals: ["worker"] });
    const removedBytes = await fs.readFile(state.configPath, "utf8");
    await expect(
      io.writeConfigFile({
        ...removed,
        session: { store: state.path("moved-after-removal", "{agentId}", "sessions.json") },
      }),
    ).rejects.toThrow(/Agent "worker" deletion cleanup is still pending/);
    expect(await fs.readFile(state.configPath, "utf8")).toBe(removedBytes);
    await io.writeConfigFile({
      ...removed,
      agents: { ...removed.agents, entries: { keeper: { name: "Renamed survivor" } } },
    });
    expect((await io.readConfigFileSnapshot()).config.agents?.entries?.keeper?.name).toBe(
      "Renamed survivor",
    );
  });
});
