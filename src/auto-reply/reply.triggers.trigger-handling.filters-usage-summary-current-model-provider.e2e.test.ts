import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { getReplyFromConfig } from "./reply.js";
import {
  getProviderUsageMocks,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

installTriggerHandlingE2eTestHooks();

const usageMocks = getProviderUsageMocks();

async function readSessionStore(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, "sessions.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function pickFirstStoreEntry<T>(store: Record<string, unknown>): T | undefined {
  const entries = Object.values(store) as T[];
  return entries[0];
}

describe("trigger handling", () => {
  it("filters usage summary to the current model provider", async () => {
    await withTempHome(async (home) => {
      usageMocks.loadProviderUsageSummary.mockClear();
      usageMocks.loadProviderUsageSummary.mockResolvedValue({
        updatedAt: 0,
        providers: [
          {
            provider: "anthropic",
            displayName: "Anthropic",
            windows: [
              {
                label: "5h",
                usedPercent: 20,
              },
            ],
          },
        ],
      });

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("Usage: Claude 80% left");
      expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
        expect.objectContaining({ providers: ["anthropic"] }),
      );
    });
  });
  it("emits /status once (no duplicate inline + final)", async () => {
    await withTempHome(async (home) => {
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(blockReplies.length).toBe(0);
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Model:");
    });
  });
  it("sets per-response usage footer via /usage", async () => {
    await withTempHome(async (home) => {
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "/usage tokens",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(blockReplies.length).toBe(0);
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Usage footer: tokens");
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });

  it("cycles /usage modes and persists to the session store", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);

      const r1 = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      expect(String((Array.isArray(r1) ? r1[0]?.text : r1?.text) ?? "")).toContain(
        "Usage footer: tokens",
      );
      const s1 = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(s1)?.responseUsage).toBe("tokens");

      const r2 = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      expect(String((Array.isArray(r2) ? r2[0]?.text : r2?.text) ?? "")).toContain(
        "Usage footer: full",
      );
      const s2 = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(s2)?.responseUsage).toBe("full");

      const r3 = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      expect(String((Array.isArray(r3) ? r3[0]?.text : r3?.text) ?? "")).toContain(
        "Usage footer: off",
      );
      const s3 = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(s3)?.responseUsage).toBeUndefined();

      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });

  it("treats /usage on as tokens (back-compat)", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/usage on",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Usage footer: tokens");

      const store = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(store)?.responseUsage).toBe("tokens");

      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });
  it("sends one inline status and still returns agent reply for mixed text", async () => {
    await withTempHome(async (home) => {
      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "agent says hi" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "here we go /status now",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1002",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(blockReplies.length).toBe(1);
      expect(String(blockReplies[0]?.text ?? "")).toContain("Model:");
      expect(replies.length).toBe(1);
      expect(replies[0]?.text).toBe("agent says hi");
      const prompt = getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/status");
    });
  });
  it("aborts even with timestamp prefix", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "[Dec 5 10:00] stop",
          From: "+1000",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });
  it("handles /stop without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });
});
