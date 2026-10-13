// Doctor heartbeat session-target tests cover heartbeat target checks and repair output.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-heartbeat-doctor-");

describe("describeHeartbeatSessionTargetIssues", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = sessionDirs.make();
  });

  function cfgWithSession(session: string, target: string | null = "slack"): OpenClawConfig {
    const heartbeat = target === null ? { session } : { session, target };
    return {
      session: {
        mainKey: "work",
        store: path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: {
        entries: {
          ops: {
            heartbeat,
          },
        },
      },
    } as OpenClawConfig;
  }

  function cfgWithDefaultHeartbeat(
    session: string,
    target: string | null = "slack",
  ): OpenClawConfig {
    const heartbeat = target === null ? { session } : { session, target };
    return {
      session: {
        mainKey: "work",
        store: path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: {
        defaults: {
          heartbeat,
        },
        entries: { ops: {} },
      },
    } as OpenClawConfig;
  }

  function writeStore(cfg: OpenClawConfig, entries: Record<string, unknown>) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(entries, null, 2));
  }

  it("uses runtime session canonicalization before warning", async () => {
    const cfg = cfgWithSession("agent:ops:main");
    writeStore(cfg, {
      "agent:ops:work": {
        sessionId: "work-session",
        updatedAt: Date.now(),
      },
    });

    expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("does not read a canonical database as JSON for a missing heartbeat target", async () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const storePath = path.join(tmpDir, "sessions.sqlite");
    cfg.session = { ...cfg.session, store: storePath };
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "agent:ops:other", storePath },
      { sessionId: "other-session", updatedAt: Date.now() },
    );
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    try {
      const warnings = await describeHeartbeatSessionTargetIssues(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
      expect(readFileSyncSpy.mock.calls.map(([file]) => file)).not.toContain(storePath);
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it("does not warn when an explicit heartbeat recipient does not need session history", async () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const agent = cfg.agents?.entries?.ops;
    if (!agent?.heartbeat) {
      throw new Error("expected test config to include heartbeat config");
    }
    agent.heartbeat.target = "telegram";
    agent.heartbeat.to = "-100123";
    writeStore(cfg, {});

    expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("does not warn when the heartbeat cadence is disabled", async () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const agent = cfg.agents?.entries?.ops;
    if (!agent?.heartbeat) {
      throw new Error("expected test config to include heartbeat config");
    }
    agent.heartbeat.every = "0m";
    writeStore(cfg, {});

    expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it.each([
    {
      name: "every agent sharing heartbeat defaults",
      configuredAgentIds: ["main", "ops"],
      heartbeatAgentId: undefined,
      expectedAgentIds: ["main", "ops"],
    },
  ])(
    "warns for missing sessions owned by $name",
    async ({ configuredAgentIds, heartbeatAgentId, expectedAgentIds }) => {
      const cfg = cfgWithDefaultHeartbeat("slack:channel:c123");
      if (!cfg.agents?.defaults?.heartbeat) {
        throw new Error("expected test config to include default heartbeat config");
      }
      cfg.agents.entries = Object.fromEntries(configuredAgentIds.map((id) => [id, {}]));
      cfg.agents.defaults.heartbeat.agentId = heartbeatAgentId;
      writeStore(cfg, {});

      const warnings = await describeHeartbeatSessionTargetIssues(cfg);

      expect(warnings).toHaveLength(expectedAgentIds.length);
      for (const [index, agentId] of expectedAgentIds.entries()) {
        expect(warnings[index]).toContain(
          `Agent ${agentId} heartbeat.session pins slack:channel:c123`,
        );
        expect(warnings[index]).toContain(`resolved to agent:${agentId}:slack:channel:c123`);
      }
    },
  );

  it("warns when the default owner target has no configured owner route", async () => {
    const cfg = cfgWithSession("slack:channel:c123", null);
    writeStore(cfg, {});

    const warning = (await describeHeartbeatSessionTargetIssues(cfg))[0];
    expect(warning).toContain('reason="no-route"');
    expect(warning).toContain('commands.ownerAllowFrom=["telegram:123456789"]');
    expect(warning).toContain('heartbeat.target="telegram"');
    expect(warning).toContain('heartbeat.to="123456789"');
    expect(warning).toContain('heartbeat.target="none"');
  });
});
