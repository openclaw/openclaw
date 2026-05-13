import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSessionEntry,
  listSessionEntries,
  upsertSessionEntry,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";

describe("describeHeartbeatSessionTargetIssues", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-doctor-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function cfgWithSession(session: string, target: string | null = "slack"): OpenClawConfig {
    const heartbeat = target === null ? { session } : { session, target };
    return {
      session: {
        mainKey: "work",
      },
      agents: {
        list: [
          {
            id: "ops",
            heartbeat,
          },
        ],
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
      },
      agents: {
        defaults: {
          heartbeat,
        },
        list: [
          {
            id: "ops",
          },
        ],
      },
    } as OpenClawConfig;
  }

  function writeStore(_cfg: OpenClawConfig, entries: Record<string, SessionEntry>) {
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    for (const { sessionKey } of listSessionEntries({ agentId: "ops" })) {
      deleteSessionEntry({ agentId: "ops", sessionKey });
    }
    for (const [sessionKey, entry] of Object.entries(entries)) {
      upsertSessionEntry({ agentId: "ops", sessionKey, entry });
    }
  }

  it("uses runtime session canonicalization before warning", () => {
    const cfg = cfgWithSession("agent:ops:main");
    writeStore(cfg, {
      "agent:ops:work": {
        sessionId: "agent:ops:work",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "123",
      },
    });

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("warns when the resolved heartbeat session is missing", () => {
    const cfg = cfgWithSession("slack:channel:c123");
    writeStore(cfg, {});

    const warnings = describeHeartbeatSessionTargetIssues(cfg);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
    expect(warnings[0]).toContain('reason="no-target"');
  });

  it("does not warn when an explicit heartbeat recipient does not need session history", () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const agent = cfg.agents?.list?.[0];
    if (!agent?.heartbeat) {
      throw new Error("expected test config to include heartbeat config");
    }
    agent.heartbeat.target = "telegram";
    agent.heartbeat.to = "-100123";
    writeStore(cfg, {});

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("does not warn when the heartbeat cadence is disabled", () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const agent = cfg.agents?.list?.[0];
    if (!agent?.heartbeat) {
      throw new Error("expected test config to include heartbeat config");
    }
    agent.heartbeat.every = "0m";
    writeStore(cfg, {});

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("warns when a default-only heartbeat session is missing", () => {
    const cfg = cfgWithDefaultHeartbeat("slack:channel:c123");
    writeStore(cfg, {});

    const warnings = describeHeartbeatSessionTargetIssues(cfg);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Agent ops heartbeat.session pins slack:channel:c123");
    expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
  });

  it("warns when an explicit heartbeat inherits a default session", () => {
    const cfg = cfgWithDefaultHeartbeat("slack:channel:c123");
    const agent = cfg.agents?.list?.[0];
    if (!agent) {
      throw new Error("expected test config to include an agent");
    }
    agent.heartbeat = {};
    writeStore(cfg, {});

    const warnings = describeHeartbeatSessionTargetIssues(cfg);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
  });

  it("does not warn when target is omitted because runtime defaults to none", () => {
    const cfg = cfgWithSession("slack:channel:c123", null);
    writeStore(cfg, {});

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });
});
