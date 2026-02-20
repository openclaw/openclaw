import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCronSession } from "./session.js";

describe("resolveCronSession forceNew for cron sessions", () => {
  it("reuses when forceNew=false and rotates when forceNew=true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-session-"));
    const storePath = path.join(dir, "session-meta.json");
    const nowMs = Date.now();
    const sessionKey = "agent:default:main:cron:test-job";

    const existingSessionId = "existing-session-id";
    const store = {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: nowMs,
        systemSent: true,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store), "utf8");

    const cfg = {
      session: {
        store: storePath,
      },
    } as never;

    const reused = resolveCronSession({
      cfg,
      sessionKey,
      nowMs: nowMs + 1_000,
      agentId: "default",
      forceNew: false,
    });
    expect(reused.sessionEntry.sessionId).toBe(existingSessionId);
    expect(reused.isNewSession).toBe(false);

    const fresh = resolveCronSession({
      cfg,
      sessionKey,
      nowMs: nowMs + 2_000,
      agentId: "default",
      forceNew: true,
    });
    expect(fresh.sessionEntry.sessionId).not.toBe(existingSessionId);
    expect(fresh.isNewSession).toBe(true);
  });

  it("keeps webhook-like sessions reusable when forceNew is false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webhook-session-"));
    const storePath = path.join(dir, "session-meta.json");
    const nowMs = Date.now();
    const sessionKey = "agent:default:main:webhook:test-hook";

    const existingSessionId = "webhook-session-id";
    const store = {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: nowMs,
        systemSent: true,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store), "utf8");

    const cfg = {
      session: {
        store: storePath,
      },
    } as never;

    const reused = resolveCronSession({
      cfg,
      sessionKey,
      nowMs: nowMs + 1_000,
      agentId: "default",
      forceNew: false,
    });

    expect(reused.sessionEntry.sessionId).toBe(existingSessionId);
    expect(reused.isNewSession).toBe(false);
  });
});
