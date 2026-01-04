import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGroupDisplayName,
  deriveSessionKey,
  loadSessionStore,
  resolveSessionKey,
  updateLastRoute,
} from "./sessions.js";

describe("sessions", () => {
  it("returns normalized per-sender key", () => {
    expect(deriveSessionKey("per-sender", { From: "whatsapp:+1555" })).toBe(
      "+1555",
    );
  });

  it("falls back to unknown when sender missing", () => {
    expect(deriveSessionKey("per-sender", {})).toBe("unknown");
  });

  it("global scope returns global", () => {
    expect(deriveSessionKey("global", { From: "+1" })).toBe("global");
  });

  it("keeps group chats distinct", () => {
    expect(deriveSessionKey("per-sender", { From: "[redacted-email]" })).toBe(
      "group:[redacted-email]",
    );
  });

  it("prefixes group keys with surface when available", () => {
    expect(
      deriveSessionKey("per-sender", {
        From: "[redacted-email]",
        ChatType: "group",
        Surface: "whatsapp",
      }),
    ).toBe("whatsapp:group:[redacted-email]");
  });

  it("keeps explicit surface when provided in group key", () => {
    expect(
      resolveSessionKey(
        "per-sender",
        { From: "group:discord:12345", ChatType: "group" },
        "main",
      ),
    ).toBe("discord:group:12345");
  });

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        surface: "discord",
        room: "#general",
        space: "friends-of-clawd",
        id: "123",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-clawd#general");
  });

  it("collapses direct chats to main by default", () => {
    expect(resolveSessionKey("per-sender", { From: "+1555" })).toBe("main");
  });

  it("collapses direct chats to main even when sender missing", () => {
    expect(resolveSessionKey("per-sender", {})).toBe("main");
  });

  it("maps direct chats to main key when provided", () => {
    expect(
      resolveSessionKey("per-sender", { From: "whatsapp:+1555" }, "main"),
    ).toBe("main");
  });

  it("uses custom main key when provided", () => {
    expect(resolveSessionKey("per-sender", { From: "+1555" }, "primary")).toBe(
      "primary",
    );
  });

  it("keeps global scope untouched", () => {
    expect(resolveSessionKey("global", { From: "+1555" })).toBe("global");
  });

  it("leaves groups untouched even with main key", () => {
    expect(
      resolveSessionKey("per-sender", { From: "[redacted-email]" }, "main"),
    ).toBe("group:[redacted-email]");
  });

  it("updateLastRoute persists channel and target", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-1",
            updatedAt: 123,
            systemSent: true,
            thinkingLevel: "low",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await updateLastRoute({
      storePath,
      sessionKey: "main",
      channel: "telegram",
      to: "  12345  ",
    });

    const store = loadSessionStore(storePath);
    expect(store.main?.sessionId).toBe("sess-1");
    expect(store.main?.updatedAt).toBeGreaterThanOrEqual(123);
    expect(store.main?.lastChannel).toBe("telegram");
    expect(store.main?.lastTo).toBe("12345");
  });
});
