import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { isCronSystemEvent } from "./heartbeat-runner.js";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Main session gets no events — undefined returned
    const main = await drainFormattedSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
    });
    expect(main).toBeUndefined();
    // Discord events untouched by main drain
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Discord session gets its own events block
    const discord = await drainFormattedSystemEvents({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
    });
    expect(discord).toMatch(/System:\s+\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });

  it("returns false for consecutive duplicate events", () => {
    const first = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });
    const second = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("normalizes context keys when checking for context changes", () => {
    const key = "agent:main:test-context";
    expect(isSystemEventContextChanged(key, " build:123 ")).toBe(true);

    enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: " BUILD:123 ",
    });

    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    expect(isSystemEventContextChanged(key, "build:456")).toBe(true);
    expect(isSystemEventContextChanged(key)).toBe(true);
  });

  it("returns cloned event entries and resets duplicate suppression after drain", () => {
    const key = "agent:main:test-entry-clone";
    enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: "build:123",
    });

    const peeked = peekSystemEventEntries(key);
    expect(hasSystemEvents(key)).toBe(true);
    expect(peeked).toHaveLength(1);
    peeked[0].text = "mutated";
    expect(peekSystemEvents(key)).toEqual(["Node connected"]);

    expect(drainSystemEventEntries(key).map((entry) => entry.text)).toEqual(["Node connected"]);
    expect(hasSystemEvents(key)).toBe(false);

    expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
  });

  it("keeps only the newest 20 queued events", () => {
    const key = "agent:main:test-max-events";
    for (let index = 1; index <= 22; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key });
    }

    expect(peekSystemEvents(key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `event ${index + 3}`),
    );
  });

  it("filters heartbeat/noise lines, returning undefined", async () => {
    const key = "agent:main:test-heartbeat-filter";
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("prefixes every line of a multi-line event", async () => {
    const key = "agent:main:test-multiline";
    enqueueSystemEvent("Post-compaction context:\nline one\nline two", { sessionKey: key });

    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(result).toBeDefined();
    const lines = result!.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("scrubs node last-input suffix", async () => {
    const key = "agent:main:test-node-scrub";
    enqueueSystemEvent("Node: Mac Studio · last input /tmp/secret.txt", { sessionKey: key });

    const result = await drainFormattedSystemEvents({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(result).toContain("Node: Mac Studio");
    expect(result).not.toContain("last input");
  });

  it("injects one-shot OAG notes into the next reply and caps the length", async () => {
    const previousHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oag-note-"));
    process.env.HOME = tempHome;
    try {
      const sentinelDir = path.join(tempHome, ".openclaw", "sentinel");
      await fs.mkdir(sentinelDir, { recursive: true });
      const statePath = path.join(sentinelDir, "channel-health-state.json");
      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            pending_user_notes: [
              {
                id: "note-1",
                created_at: "2026-03-15T10:20:30+08:00",
                message:
                  "刚才检测到消息通道恢复不彻底，我已自动做了一次恢复校验，并继续观察队列排空情况，必要时会继续升级处理。",
                targets: [{ sessionKeys: ["telegram:direct:ops"] }],
              },
              {
                id: "note-2",
                created_at: "2026-03-15T10:20:31+08:00",
                message: "这条不该出现在当前会话里。",
                targets: [{ sessionKeys: ["telegram:direct:other"] }],
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const result = await drainFormattedSystemEvents({
        cfg,
        sessionKey: "telegram:direct:ops",
        isMainSession: false,
        isNewSession: false,
      });

      expect(result).toContain("System: [");
      expect(result).toContain("OAG: 刚才检测到消息通道恢复不彻底，我已自动做了一次恢复校验");
      expect(result).not.toContain("这条不该出现在当前会话里");
      expect(result?.split("\n")).toHaveLength(1);

      const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        pending_user_notes?: Array<{ id?: string }>;
        delivered_user_notes?: Array<{ id?: string; delivered_session_key?: string }>;
      };
      expect(persisted.pending_user_notes?.map((note) => note.id)).toEqual(["note-2"]);
      expect(persisted.delivered_user_notes?.map((note) => note.id)).toContain("note-1");
      expect(
        persisted.delivered_user_notes?.find((note) => note.id === "note-1")?.delivered_session_key,
      ).toBe("telegram:direct:ops");
    } finally {
      process.env.HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("localizes one-shot OAG notes for English sessions", async () => {
    const previousHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oag-note-en-"));
    process.env.HOME = tempHome;
    try {
      const sessionsDir = path.join(tempHome, ".openclaw", "agents", "main", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = path.join(sessionsDir, "sid-en.jsonl");
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sid-en",
            timestamp: "2026-03-15T10:20:29+08:00",
            cwd: process.cwd(),
          }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: "2026-03-15T10:20:29+08:00",
            message: { role: "user", content: "Please keep system reports in English." },
          }),
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "sid-en",
              sessionFile,
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      const sentinelDir = path.join(tempHome, ".openclaw", "sentinel");
      await fs.mkdir(sentinelDir, { recursive: true });
      const statePath = path.join(sentinelDir, "channel-health-state.json");
      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            pending_user_notes: [
              {
                id: "note-en",
                action: "gateway_restart_triggered",
                created_at: "2026-03-15T10:20:30+08:00",
                message: "刚才检测到消息通道恢复后仍有积压，我已自动重启消息网关继续恢复。",
                targets: [{ sessionKeys: ["agent:main:main"] }],
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const result = await drainFormattedSystemEvents({
        cfg,
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
      });

      expect(result).toContain(
        "OAG: I restarted the message gateway to clear lingering channel backlog.",
      );
      expect(result).not.toContain("刚才检测到消息通道恢复后仍有积压");
    } finally {
      process.env.HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("coalesces multiple matched OAG notes into the latest single line", async () => {
    const previousHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oag-note-coalesce-"));
    process.env.HOME = tempHome;
    try {
      const sessionsDir = path.join(tempHome, ".openclaw", "agents", "main", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = path.join(sessionsDir, "sid-zh.jsonl");
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sid-zh",
            timestamp: "2026-03-15T10:20:29+08:00",
            cwd: process.cwd(),
          }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: "2026-03-15T10:20:29+08:00",
            message: { role: "user", content: "请继续用中文告诉我系统情况。" },
          }),
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "sid-zh",
              sessionFile,
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      const sentinelDir = path.join(tempHome, ".openclaw", "sentinel");
      await fs.mkdir(sentinelDir, { recursive: true });
      const statePath = path.join(sentinelDir, "channel-health-state.json");
      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            pending_user_notes: [
              {
                id: "note-old",
                action: "recovery_verify",
                created_at: "2026-03-15T10:20:30+08:00",
                message: "刚才消息通道恢复不彻底，我已自动做了一次恢复校验。",
                targets: [{ sessionKeys: ["agent:main:main"] }],
              },
              {
                id: "note-new",
                action: "channel_backlog_cleared",
                created_at: "2026-03-15T10:21:30+08:00",
                message: "刚才消息通道短暂堵塞，积压已清空，系统已恢复处理。",
                targets: [{ sessionKeys: ["agent:main:main"] }],
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const result = await drainFormattedSystemEvents({
        cfg,
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
      });

      expect(result?.split("\n")).toHaveLength(1);
      expect(result).toContain("刚才消息通道短暂堵塞，积压已清空，系统已恢复处理。");
      expect(result).not.toContain("刚才消息通道恢复不彻底");

      const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        pending_user_notes?: Array<{ id?: string }>;
        delivered_user_notes?: Array<{ id?: string }>;
      };
      expect(persisted.pending_user_notes ?? []).toHaveLength(0);
      expect(persisted.delivered_user_notes?.map((note) => note.id)).toEqual([
        "note-old",
        "note-new",
      ]);
    } finally {
      process.env.HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("matches OAG notes that use snake_case session_keys targets", async () => {
    const previousHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oag-note-snake-"));
    process.env.HOME = tempHome;
    try {
      const sentinelDir = path.join(tempHome, ".openclaw", "sentinel");
      await fs.mkdir(sentinelDir, { recursive: true });
      const statePath = path.join(sentinelDir, "channel-health-state.json");
      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            pending_user_notes: [
              {
                id: "note-snake",
                created_at: "2026-03-15T10:20:30+08:00",
                message: "通道恢复完成，继续观察。",
                targets: [{ session_keys: ["telegram:direct:ops"] }],
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const result = await drainFormattedSystemEvents({
        cfg,
        sessionKey: "telegram:direct:ops",
        isMainSession: false,
        isNewSession: false,
      });

      expect(result).toContain("OAG: 通道恢复完成，继续观察。");
    } finally {
      process.env.HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe("isCronSystemEvent", () => {
  it("returns false for empty entries", () => {
    expect(isCronSystemEvent("")).toBe(false);
    expect(isCronSystemEvent("   ")).toBe(false);
  });

  it("returns false for heartbeat ack markers", () => {
    expect(isCronSystemEvent("HEARTBEAT_OK")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK 🦞")).toBe(false);
    expect(isCronSystemEvent("heartbeat_ok")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK:")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK, continue")).toBe(false);
  });

  it("returns false for heartbeat poll and wake noise", () => {
    expect(isCronSystemEvent("heartbeat poll: pending")).toBe(false);
    expect(isCronSystemEvent("heartbeat wake complete")).toBe(false);
  });

  it("returns false for exec completion events", () => {
    expect(isCronSystemEvent("Exec finished (gateway id=abc, code 0)")).toBe(false);
  });

  it("returns true for real cron reminder content", () => {
    expect(isCronSystemEvent("Reminder: Check Base Scout results")).toBe(true);
    expect(isCronSystemEvent("Send weekly status update to the team")).toBe(true);
  });
});
