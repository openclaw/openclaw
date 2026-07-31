import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../legacy.roster.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStoreCompatibilityAgentId, resolveSessionStoreTargets } from "./targets.js";

describe("fixed session store ownership", () => {
  it("uses sole ownership without changing ambiguous or main compatibility anchors", () => {
    expect(
      resolveSessionStoreCompatibilityAgentId({
        agents: { entries: { ops: {}, main: {} } },
      }),
    ).toBe("main");
    expect(
      resolveSessionStoreCompatibilityAgentId({
        agents: { entries: { ops: {} } },
      }),
    ).toBe("ops");
    expect(
      resolveSessionStoreCompatibilityAgentId({
        agents: { entries: { main: {} } },
      }),
    ).toBe("main");
  });

  it("keeps a shipped sole non-main fixed-store owner after marker migration and restart", () => {
    const migrated = migratePersistedImplicitMainRoster({
      session: { store: "/tmp/openclaw-sole-ops-sessions.json" },
      agents: { entries: { ops: { default: true } } },
    });
    const restarted = structuredClone(migrated.config) as OpenClawConfig;

    expect(restarted.agents?.entries?.ops?.default).toBeUndefined();
    expect(resolveSessionStoreCompatibilityAgentId(restarted)).toBe("ops");
  });

  it("keeps a shipped multi-agent fixed-store owner after migration and restart", () => {
    const migrated = migratePersistedImplicitMainRoster({
      session: { store: "/tmp/openclaw-multi-ops-sessions.json" },
      agents: { entries: { ops: { default: true }, research: {} } },
    });
    const restarted = structuredClone(migrated.config) as OpenClawConfig;

    expect(restarted.agents?.entries?.ops?.default).toBeUndefined();
    expect(restarted.agents?.defaults?.sessionStore?.agentId).toBe("ops");
    expect(resolveSessionStoreCompatibilityAgentId(restarted)).toBe("ops");
  });

  it("falls back from a departed retained owner to the sole live agent", () => {
    const cfg = retainLegacyDefaultAgentId({ agents: { entries: { research: {} } } }, "ops");

    expect(resolveSessionStoreCompatibilityAgentId(cfg)).toBe("research");
  });

  it("keeps a colliding target on the retained legacy owner", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "ops.json");
      const diagnostics: string[] = [];
      const cfg = retainLegacyDefaultAgentId(
        {
          session: { store: storePath },
          agents: { entries: { main: {}, ops: {} } },
        },
        "ops",
      );

      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "main", storePath },
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toContainEqual(expect.stringContaining('suffixed owner(s): "main"'));
    });
  });
});
