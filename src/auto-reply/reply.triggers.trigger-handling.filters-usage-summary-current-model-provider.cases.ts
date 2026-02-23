import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionKey } from "../config/sessions.js";
import {
  createBlockReplyCollector,
  getProviderUsageMocks,
  getRunEmbeddedPiAgentMock,
  makeCfg,
  requireSessionStorePath,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

type GetReplyFromConfig = typeof import("./reply.js").getReplyFromConfig;

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

async function readSessionStore(storePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(storePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function pickFirstStoreEntry<T>(store: Record<string, unknown>): T | undefined {
  const entries = Object.values(store) as T[];
  return entries[0];
}

function getReplyFromConfigNow(getReplyFromConfig: () => GetReplyFromConfig): GetReplyFromConfig {
  return getReplyFromConfig();
}

async function runCommandAndCollectReplies(params: {
  getReplyFromConfig: () => GetReplyFromConfig;
  home: string;
  body: string;
  from?: string;
  senderE164?: string;
}) {
  const { blockReplies, handlers } = createBlockReplyCollector();
  const res = await getReplyFromConfigNow(params.getReplyFromConfig)(
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

async function expectStopAbortWithoutAgent(params: {
  getReplyFromConfig: () => GetReplyFromConfig;
  home: string;
  body: string;
  from: string;
}) {
  const res = await getReplyFromConfigNow(params.getReplyFromConfig)(
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

export function registerTriggerHandlingUsageSummaryCases(params: {
  getReplyFromConfig: () => GetReplyFromConfig;
}): void {
  describe("usage and status command handling", () => {
    it("handles status, usage cycles, restart/stop gating, and auth-profile status details", async () => {
      await withTempHome(async (home) => {
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        const getReplyFromConfig = getReplyFromConfigNow(params.getReplyFromConfig);
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

        {
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
          expect(text).toContain("Model:");
          expect(text).toContain("OpenClaw");
          expect(normalizeTestText(text ?? "")).toContain("Usage: Claude 80% left");
          expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
            expect.objectContaining({ providers: ["anthropic"] }),
          );
          expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
        }

        {
          runEmbeddedPiAgentMock.mockResolvedValue({
            payloads: [{ text: "agent says hi" }],
            meta: {
              durationMs: 1,
              agentMeta: { sessionId: "s", provider: "p", model: "m" },
            },
          });
          const { blockReplies, replies } = await runCommandAndCollectReplies({
            getReplyFromConfig: params.getReplyFromConfig,
            home,
            body: "here we go /status now",
            from: "+1002",
          });
          expect(blockReplies.length).toBe(1);
          expect(String(blockReplies[0]?.text ?? "")).toContain("Model:");
          expect(replies.length).toBe(1);
          expect(replies[0]?.text).toBe("agent says hi");
          const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
          expect(prompt).not.toContain("/status");
        }

        {
          runEmbeddedPiAgentMock.mockClear();
          const defaultCfg = makeCfg(home);
          const cfg = {
            ...defaultCfg,
            models: {
              providers: {
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  api: "anthropic-messages",
                },
              },
            },
          } as unknown as OpenClawConfig;
          const defaultStatus = await getReplyFromConfig(modelStatusCtx, {}, defaultCfg);
          const configuredStatus = await getReplyFromConfig(modelStatusCtx, {}, cfg);

          expect(
            normalizeTestText(
              (Array.isArray(defaultStatus) ? defaultStatus[0]?.text : defaultStatus?.text) ?? "",
            ),
          ).toContain("endpoint: default");
          const configuredText = Array.isArray(configuredStatus)
            ? configuredStatus[0]?.text
            : configuredStatus?.text;
          expect(normalizeTestText(configuredText ?? "")).toContain(
            "[minimax] endpoint: https://api.minimax.io/anthropic api: anthropic-messages auth:",
          );
        }

        {
          const cfg = makeCfg(home);
          cfg.session = { ...cfg.session, store: join(home, "usage-cycle.sessions.json") };
          const usageStorePath = requireSessionStorePath(cfg);
          const explicitTokens = await getReplyFromConfig(
            {
              Body: "/usage tokens",
              From: "+1000",
              To: "+2000",
              Provider: "whatsapp",
              SenderE164: "+1000",
              CommandAuthorized: true,
            },
            undefined,
            cfg,
          );
          expect(
            String(
              (Array.isArray(explicitTokens) ? explicitTokens[0]?.text : explicitTokens?.text) ??
                "",
            ),
          ).toContain("Usage footer: tokens");
          const explicitStore = await readSessionStore(usageStorePath);
          expect(
            pickFirstStoreEntry<{ responseUsage?: string }>(explicitStore)?.responseUsage,
          ).toBe("tokens");

          const r0 = await getReplyFromConfig(
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
          expect(String((Array.isArray(r0) ? r0[0]?.text : r0?.text) ?? "")).toContain(
            "Usage footer: tokens",
          );

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
            "Usage footer: full",
          );

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
            "Usage footer: off",
          );

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
            "Usage footer: tokens",
          );
          const finalStore = await readSessionStore(usageStorePath);
          expect(pickFirstStoreEntry<{ responseUsage?: string }>(finalStore)?.responseUsage).toBe(
            "tokens",
          );
          expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
        }

        {
          runEmbeddedPiAgentMock.mockClear();
          await expectStopAbortWithoutAgent({
            getReplyFromConfig: params.getReplyFromConfig,
            home,
            body: "[Dec 5 10:00] stop",
            from: "+1000",
          });

          const enabledRes = await getReplyFromConfig(
            {
              Body: "  [Dec 5] /restart",
              From: "+1001",
              To: "+2000",
              CommandAuthorized: true,
            },
            {},
            makeCfg(home),
          );
          const enabledText = Array.isArray(enabledRes) ? enabledRes[0]?.text : enabledRes?.text;
          expect(
            enabledText?.startsWith("⚙️ Restarting") ||
              enabledText?.startsWith("⚠️ Restart failed"),
          ).toBe(true);

          const disabledCfg = { ...makeCfg(home), commands: { restart: false } } as OpenClawConfig;
          const disabledRes = await getReplyFromConfig(
            {
              Body: "/restart",
              From: "+1001",
              To: "+2000",
              CommandAuthorized: true,
            },
            {},
            disabledCfg,
          );

          const disabledText = Array.isArray(disabledRes)
            ? disabledRes[0]?.text
            : disabledRes?.text;
          expect(disabledText).toContain("/restart is disabled");
          expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
        }

        {
          runEmbeddedPiAgentMock.mockClear();
          const cfg = makeCfg(home);
          cfg.session = { ...cfg.session, store: join(home, "auth-profile-status.sessions.json") };
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
          expect(text).toContain("sk-tes");
          expect(text).toContain("abcdef");
          expect(text).not.toContain("1234567890abcdef");
          expect(text).toContain("(anthropic:work)");
          expect(text).not.toContain("mixed");
          expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
        }
      });
    });
  });
}
