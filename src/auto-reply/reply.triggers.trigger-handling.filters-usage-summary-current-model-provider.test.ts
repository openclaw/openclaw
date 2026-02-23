import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionKey } from "../config/sessions.js";
import {
  createBlockReplyCollector,
  getProviderUsageMocks,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  requireSessionStorePath,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

const usageMocks = getProviderUsageMocks();
const modelStatusCtx = {
  Body: "/model status",
  From: "telegram:111",
  To: "telegram:111",
  ChatType: "direct",
  Provider: "telegram",
  Surface: "telegram",
  SessionKey: "telegram:slash:111",
  CommandAuthorized: true,
} as const;

async function readSessionStore(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, "sessions.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function pickFirstStoreEntry<T>(store: Record<string, unknown>): T | undefined {
  const entries = Object.values(store) as T[];
  return entries[0];
}

async function runCommandAndCollectReplies(params: {
  home: string;
  body: string;
  from?: string;
  senderE164?: string;
}) {
  const { blockReplies, handlers } = createBlockReplyCollector();
  const res = await getReplyFromConfig(
    {
      Body: params.body,
      From: params.from ?? "+1000",
      To: "+2000",
      Provider: "whatsapp",
      SenderE164: params.senderE164 ?? params.from ?? "+1000",
      CommandAuthorized: true,
    },
    handlers,
    makeCfg(params.home),
  );
  const replies = res ? (Array.isArray(res) ? res : [res]) : [];
  return { blockReplies, replies };
}

async function expectStopAbortWithoutAgent(params: { home: string; body: string; from: string }) {
  const res = await getReplyFromConfig(
    {
      Body: params.body,
      From: params.from,
      To: "+2000",
      CommandAuthorized: true,
    },
    {},
    makeCfg(params.home),
  );
  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  expect(text).toBe("⚙️ Agent was aborted.");
  expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
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
      const { blockReplies, replies } = await runCommandAndCollectReplies({
        home,
        body: "/status",
      });
      expect(blockReplies.length).toBe(0);
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Model:");
    });
  });
  it("sets per-response usage footer via /usage", async () => {
    await withTempHome(async (home) => {
      const { blockReplies, replies } = await runCommandAndCollectReplies({
        home,
        body: "/usage tokens",
      });
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
      const { blockReplies, replies } = await runCommandAndCollectReplies({
        home,
        body: "here we go /status now",
        from: "+1002",
      });
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
      await expectStopAbortWithoutAgent({
        home,
        body: "[Dec 5 10:00] stop",
        from: "+1000",
      });
    });
  });
  it("handles /stop without invoking the agent", async () => {
    await withTempHome(async (home) => {
      await expectStopAbortWithoutAgent({
        home,
        body: "/stop",
        from: "+1003",
      });
    });
  });

  it("shows endpoint default in /model status when not configured", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(modelStatusCtx, {}, cfg);

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("endpoint: default");
    });
  });

  it("includes endpoint details in /model status when configured", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        ...makeCfg(home),
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              api: "anthropic-messages",
            },
          },
        },
      } as unknown as OpenClawConfig;
      const res = await getReplyFromConfig(modelStatusCtx, {}, cfg);

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain(
        "[minimax] endpoint: https://api.minimax.io/anthropic api: anthropic-messages auth:",
      );
    });
  });

  it("restarts by default", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const res = await getReplyFromConfig(
        {
          Body: "  [Dec 5] /restart",
          From: "+1001",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text?.startsWith("⚙️ Restarting") || text?.startsWith("⚠️ Restart failed")).toBe(true);
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });

  it("rejects /restart when explicitly disabled", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const cfg = { ...makeCfg(home), commands: { restart: false } } as OpenClawConfig;
      const res = await getReplyFromConfig(
        {
          Body: "/restart",
          From: "+1001",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("/restart is disabled");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });

  it("reports status without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1002",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("OpenClaw");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });

  it("reports active auth profile and key snippet in status", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const cfg = makeCfg(home);
      const agentDir = join(home, ".openclaw", "agents", "main", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "auth-profiles.json"),
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-test-1234567890abcdef",
              },
            },
            lastGood: { anthropic: "anthropic:work" },
          },
          null,
          2,
        ),
      );

      const sessionKey = resolveSessionKey("per-sender", {
        From: "+1002",
        To: "+2000",
        Provider: "whatsapp",
      } as Parameters<typeof resolveSessionKey>[1]);
      await writeFile(
        requireSessionStorePath(cfg),
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "session-auth",
              updatedAt: Date.now(),
              authProfileOverride: "anthropic:work",
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1002",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("api-key");
      expect(text).toMatch(/\u2026|\.{3}/);
      expect(text).toContain("(anthropic:work)");
      expect(text).not.toContain("mixed");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
});
