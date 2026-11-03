import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES } from "./legacy-config-migrations.runtime.tool-names.js";

function migrate(id: string, raw: Record<string, unknown>) {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES.find((entry) => entry.id === id);
  expect(migration).toBeDefined();
  const changes: string[] = [];
  migration!.apply(raw, changes);
  return changes;
}

describe("legacy tool name migrations", () => {
  it.each([
    { id: "tools.suggest-task-name", legacy: "spawn_task", canonical: "suggest_task" },
    { id: "tools.view-image-name", legacy: "image", canonical: "view_image" },
  ])("rewrites $legacy only on core-owned policy surfaces", ({ id, legacy, canonical }) => {
    const sender = () => ({ "id:guest": { deny: [legacy] } });
    const policy = () => ({
      allow: [legacy, "read"],
      byProvider: { openai: { deny: [legacy.toUpperCase()] } },
      sandbox: { tools: { alsoAllow: [` ${legacy} `] } },
      toolsBySender: sender(),
    });
    const raw = {
      tools: {
        ...policy(),
        subagents: { tools: { deny: [legacy] } },
        agentToAgent: { allow: [legacy] },
      },
      agents: { entries: { main: { tools: policy() } } },
      channels: {
        discord: { guilds: { "1": { tools: { allow: [legacy] }, toolsBySender: sender() } } },
      },
      gateway: { tools: { allow: [legacy], deny: [legacy, "image_generate"] } },
      plugins: { entries: { example: { config: { toolsAllow: [legacy] } } } },
    };
    expect(migrate(id, raw)).toHaveLength(1);
    for (const tools of [raw.tools, raw.agents.entries.main.tools]) {
      expect(tools.allow).toEqual([canonical, "read"]);
      expect(tools.byProvider.openai.deny).toEqual([canonical]);
      expect(tools.sandbox.tools.alsoAllow).toEqual([canonical]);
      expect(tools.toolsBySender["id:guest"].deny).toEqual([canonical]);
    }
    expect(raw.tools.subagents.tools.deny).toEqual([canonical]);
    expect(raw.channels.discord.guilds["1"]).toEqual({
      tools: { allow: [canonical] },
      toolsBySender: { "id:guest": { deny: [canonical] } },
    });
    expect(raw.gateway.tools).toEqual({ allow: [canonical], deny: [canonical, "image_generate"] });
    expect(raw.tools.agentToAgent.allow).toEqual([legacy]);
    expect(raw.plugins.entries.example.config.toolsAllow).toEqual([legacy]);
  });

  it.each([
    { entries: ["image*"], expected: ["image*", "view_image"], changed: 1 },
    { entries: ["*"], expected: ["*"], changed: 0 },
    { entries: ["image*", "view_*"], expected: ["image*", "view_*"], changed: 0 },
  ])("preserves wildcard coverage: $entries", ({ entries, expected, changed }) => {
    const raw = { tools: { allow: entries } };
    expect(migrate("tools.view-image-name", raw)).toHaveLength(changed);
    expect(raw.tools.allow).toEqual(expected);
  });

  it("adds skill_library beside skill_workshop and keeps the Workshop entry", () => {
    const raw = {
      tools: {
        allow: ["skill_workshop", "read"],
        deny: ["SKILL_WORKSHOP"],
        sandbox: { tools: { alsoAllow: ["skill_*"] } },
      },
      agents: { entries: { main: { tools: { allow: ["skill_workshop", "skill_library"] } } } },
    };
    expect(migrate("tools.skill-library-split", raw)).toHaveLength(1);
    expect(raw.tools.allow).toEqual(["skill_workshop", "read", "skill_library"]);
    // A deny of skill_workshop also hid personal-library authoring before the split.
    expect(raw.tools.deny).toEqual(["SKILL_WORKSHOP", "skill_library"]);
    // Globs and lists that already cover skill_library stay unchanged.
    expect(raw.tools.sandbox.tools.alsoAllow).toEqual(["skill_*"]);
    expect(raw.agents.entries.main.tools.allow).toEqual(["skill_workshop", "skill_library"]);
    expect(migrate("tools.skill-library-split", raw)).toEqual([]);
  });
});
