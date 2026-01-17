import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { initSessionState } from "./session.js";

describe("initSessionState sender meta", () => {
  it("injects sender meta into BodyStripped for group chats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sender-meta-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as ClawdbotConfig;

    const result = await initSessionState({
      ctx: {
        Body: "[WhatsApp 123@g.us] ping",
        ChatType: "group",
        SenderName: "Bob",
        SenderE164: "+222",
        SenderId: "222@s.whatsapp.net",
        SessionKey: "agent:main:whatsapp:group:123@g.us",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("[WhatsApp 123@g.us] ping\n[from: Bob (+222)]");
  });

  it("does not inject sender meta for direct chats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sender-meta-direct-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as ClawdbotConfig;

    const result = await initSessionState({
      ctx: {
        Body: "[WhatsApp +1] ping",
        ChatType: "direct",
        SenderName: "Bob",
        SenderE164: "+222",
        SessionKey: "agent:main:whatsapp:dm:+222",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("[WhatsApp +1] ping");
  });
});
