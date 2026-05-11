import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";

describe("describeHeartbeatSessionTargetIssues", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-doctor-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function cfgWithSession(session: string): OpenClawConfig {
    return {
      session: {
        mainKey: "work",
        store: path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: {
        list: [
          {
            id: "ops",
            heartbeat: {
              session,
              target: "slack",
            },
          },
        ],
      },
    } as OpenClawConfig;
  }

  function writeStore(cfg: OpenClawConfig, entries: Record<string, unknown>) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "ops" });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(entries, null, 2));
  }

  it("uses runtime session canonicalization before warning", () => {
    const cfg = cfgWithSession("agent:ops:main");
    writeStore(cfg, {
      "agent:ops:work": {
        sessionId: "agent:ops:work",
        updatedAt: Date.now(),
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
});
