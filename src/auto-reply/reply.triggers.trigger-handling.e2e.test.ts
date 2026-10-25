import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import {
  expectInlineCommandHandledAndStripped,
  getCompactEmbeddedAgentSessionMock,
  getRunEmbeddedAgentMock,
  installTriggerHandlingReplyHarness,
  MAIN_SESSION_KEY,
  makeCfg,
  mockRunEmbeddedAgentOk,
  requireSessionStorePath,
  withTempHome,
} from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { dispatchInboundMessage } from "./dispatch.js";
import { registerGroupIntroPromptCases } from "./reply.triggers.group-intro-prompts.cases.js";
import { registerTriggerHandlingUsageSummaryCases } from "./reply.triggers.trigger-handling.filters-usage-summary-current-model-provider.cases.js";
import { markCompleteReplyConfig } from "./reply/get-reply-fast-path.test-support.js";
import { createReplyDispatcher } from "./reply/reply-dispatcher.js";
import type { MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type GetReplyFromConfig = typeof import("./reply/get-reply.js").getReplyFromConfig;
type ReplyAgentParams = Parameters<typeof import("./reply/agent-runner-run.js").runReplyAgent>[0];

async function withUnavailableThinkingCatalog(
  run: (
    catalog: MockInstance<
      typeof import("../agents/model-catalog.runtime.js").loadProviderScopedThinkingCatalog
    >,
  ) => Promise<void>,
): Promise<void> {
  const catalog = vi
    .spyOn(await import("../agents/model-catalog.runtime.js"), "loadProviderScopedThinkingCatalog")
    .mockRejectedValue(new Error("thinking catalog unavailable"));
  try {
    return await run(catalog);
  } finally {
    catalog.mockRestore();
  }
}

const TEST_PRIMARY_PROFILE_ID = "openai:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai:secondary@example.test";
const TEST_TIME_ZONE = "America/Chicago";
const TELEGRAM_DIRECT_MESSAGE = {
  From: "telegram:111",
  To: "telegram:111",
  ChatType: "direct",
  Provider: "telegram",
  Surface: "telegram",
} as const;

// mock-isolation: Exercise command routing without starting a provider-backed agent runtime.
vi.mock("./reply/agent-runner-run.js", () => ({
  runReplyAgent: async ({ commandBody, followupRun: { run } }: ReplyAgentParams) => {
    const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
    const result = await runEmbeddedAgentMock({
      prompt: commandBody,
      provider: run.provider,
      model: run.model,
      authProfileId: run.authProfileId,
      authProfileIdSource: run.authProfileIdSource,
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      sessionFile: run.sessionFile,
      workspaceDir: run.workspaceDir,
      config: run.config,
      extraSystemPrompt: run.extraSystemPrompt,
    });
    return { text: result?.payloads?.[0]?.text };
  },
}));

let capturedGetReplyFromConfig: GetReplyFromConfig | undefined;
installTriggerHandlingReplyHarness((impl) => {
  capturedGetReplyFromConfig = impl;
});

function getReplyFromConfig(
  ...args: Parameters<GetReplyFromConfig>
): ReturnType<GetReplyFromConfig> {
  if (!capturedGetReplyFromConfig) {
    throw new Error("Expected trigger handling reply harness to install getReplyFromConfig");
  }
  return capturedGetReplyFromConfig(...args);
}

const BASE_MESSAGE = {
  Body: "hello",
  From: "+1002",
  To: "+2000",
} as const;

function maybeReplyText(reply: Awaited<ReturnType<GetReplyFromConfig>>) {
  return Array.isArray(reply) ? reply[0]?.text : reply?.text;
}

async function seedTargetSession(
  storePath: string,
  sessionKey: string,
  overrides: Partial<NonNullable<ReturnType<typeof loadSessionEntry>>> = {},
) {
  await replaceSessionEntry(
    { storePath, sessionKey },
    { sessionId: "session-target", updatedAt: Date.now(), ...overrides },
  );
}

function makeNativeTelegramCommandMessage(params: {
  body: string;
  slashSessionKey: string;
  targetSessionKey: string;
}): MsgContext {
  return {
    Body: params.body,
    ...TELEGRAM_DIRECT_MESSAGE,
    SessionKey: params.slashSessionKey,
    CommandSource: "native",
    CommandTargetSessionKey: params.targetSessionKey,
    CommandAuthorized: true,
  };
}

async function runAuthorizedSmsCommand(body: string, cfg: ReturnType<typeof makeCfg>) {
  return await getReplyFromConfig(
    { ...BASE_MESSAGE, Body: body, From: "+1003", CommandAuthorized: true },
    {},
    cfg,
  );
}

async function expectResetBlockedForNonOwner(params: {
  home: string;
  command: "/new" | "/reset";
}): Promise<void> {
  const { home, command } = params;
  const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
  runEmbeddedAgentMock.mockClear();
  const cfg = makeCfg(home);
  cfg.channels ??= {};
  cfg.channels.whatsapp = {
    ...cfg.channels.whatsapp,
    allowFrom: ["+1999"],
  };
  cfg.commands = {
    ...cfg.commands,
    ownerAllowFrom: ["whatsapp:+1999"],
  };
  await withUnavailableThinkingCatalog(async (catalog) => {
    const res = await getReplyFromConfig(
      {
        Body: command,
        From: "+1003",
        To: "+2000",
        CommandAuthorized: false,
      },
      {},
      cfg,
    );
    expect(res).toBeUndefined();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });
}

describe("trigger handling", () => {
  registerGroupIntroPromptCases();
  registerTriggerHandlingUsageSummaryCases({
    getReplyFromConfig: () => getReplyFromConfig,
  });

  it.each([
    { command: "/new", text: "✅ New session started.", reset: false },
    { command: "/RESET", text: "✅ Session reset.", reset: true },
  ])(
    "acknowledges bare $command without invoking the model or loading startup memory",
    async ({ command, text, reset }) => {
      await withTempHome(async (home) => {
        const memoryDir = join(home, "openclaw", "memory");
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: TEST_TIME_ZONE });
        await fs.mkdir(memoryDir, { recursive: true });
        for (const daysAgo of [0, 1]) {
          const stamp = date.format(Date.now() - daysAgo * 86_400_000);
          await fs.writeFile(join(memoryDir, `${stamp}.md`), "startup note");
        }
        const runEmbeddedAgentMock = mockRunEmbeddedAgentOk("hello");

        const cfg = makeCfg(home);
        cfg.agents = {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            userTimezone: TEST_TIME_ZONE,
            ...(reset ? { startupContext: { applyOn: ["reset"] } } : {}),
          },
        };

        await withUnavailableThinkingCatalog(async (catalog) => {
          const res = await runAuthorizedSmsCommand(command, cfg);
          expect(maybeReplyText(res)).toBe(text);
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
          expect(catalog).not.toHaveBeenCalled();
        });
      });
    },
  );

  it("resolves model capabilities when /new includes follow-up text", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedAgentMock = mockRunEmbeddedAgentOk("hello");
      await withUnavailableThinkingCatalog(async (catalog) => {
        await expect(runAuthorizedSmsCommand("/new take notes", makeCfg(home))).rejects.toThrow(
          "thinking catalog unavailable",
        );
        expect(catalog).toHaveBeenCalledOnce();
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      });
    });
  });

  it("strips current thinking directives without rewriting history", async () => {
    await withTempHome(async (home) => {
      const historyBody = [
        "[Chat messages since your last reply - for context]",
        "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
        "",
        "[Current message - respond to this]",
        "Give me the status",
      ].join("\n");
      const currentBody = "Give me the status\n\nif ready:\n    report_status()";
      const message = { ...BASE_MESSAGE, CommandAuthorized: true };
      const thinkCases = [
        [
          "context-wrapper",
          { ...message, Body: historyBody, commandText: "Give me the status" },
          {},
          historyBody,
        ],
        ["current-message", { ...message, Body: `/thinking high ${currentBody}` }, {}, currentBody],
      ] as const;
      for (const [label, request, options, expectedPrompt] of thinkCases) {
        const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
        runEmbeddedAgentMock.mockReset();
        mockRunEmbeddedAgentOk();
        const res = await getReplyFromConfig(request, options, makeCfg(home));
        const text = maybeReplyText(res);
        expect(text, label).toBe("ok");
        expect(text, label).not.toMatch(/Thinking level set/i);
        expect(runEmbeddedAgentMock, label).toHaveBeenCalledOnce();
        expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt, label).toBe(expectedPrompt);
      }
    });
  });

  it("compacts the routed worker session and persists its count", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const storePath = requireSessionStorePath(cfg);
      const sessionKey = "agent:worker1:telegram:12345";
      const request = {
        Body: "/compact",
        From: "+1004",
        To: "+2000",
        SessionKey: sessionKey,
      };
      await seedTargetSession(storePath, sessionKey, { sessionId: "compact-worker-session" });
      getCompactEmbeddedAgentSessionMock().mockReset();
      getCompactEmbeddedAgentSessionMock().mockResolvedValue({
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "x",
          tokensBefore: 12000,
          tokensAfter: 1000,
        },
      });
      const res = await getReplyFromConfig({ ...request, CommandAuthorized: true }, {}, cfg);
      expect(maybeReplyText(res)).toMatch(/^⚙️ Compacted/u);
      expect(getCompactEmbeddedAgentSessionMock()).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ storePath, sessionKey })?.compactionCount).toBe(1);
      expect(getCompactEmbeddedAgentSessionMock().mock.calls[0]?.[0]).toMatchObject({
        sessionTarget: { agentId: "worker1", sessionKey, storePath },
        sessionFile: sessionKey,
      });
    });
  });

  it.each([
    { command: "/new", text: "✅ New session started." },
    { command: "/reset", text: "✅ Session reset." },
  ] as const)(
    "commits native $command in an idle group topic and fires its command hook",
    async ({ command, text }) => {
      await withTempHome(async (home) => {
        const action = command.slice(1);
        // Full runtime: the fast test bootstrap skips the real session rollover.
        const cfg = markCompleteReplyConfig(makeCfg(home), {
          runtimeMode: "full",
        });
        setRuntimeConfigSnapshot(cfg);
        onTestFinished(clearRuntimeConfigSnapshot);
        const storePath = requireSessionStorePath(cfg);
        // Native topic commands run on the target itself: do not preempt their own turn.
        const targetSessionKey = "agent:main:telegram:group:-1001234567890:topic:42";
        await seedTargetSession(storePath, targetSessionKey, { lifecycleRevision: "before-reset" });
        const hookEvents: string[] = [];
        const hook = (event: { type: string; action: string }) => {
          hookEvents.push(`${event.type}:${event.action}`);
        };
        registerInternalHook(`command:${action}`, hook);
        onTestFinished(() => unregisterInternalHook(`command:${action}`, hook));
        const replies: ReplyPayload[] = [];
        const dispatcher = createReplyDispatcher({
          deliver: async (payload) => {
            replies.push(payload);
          },
        });
        const result = await dispatchInboundMessage({
          ctx: {
            ...makeNativeTelegramCommandMessage({
              body: command,
              slashSessionKey: targetSessionKey,
              targetSessionKey,
            }),
            ChatType: "group",
            To: "telegram:-1001234567890",
            MessageThreadId: 42,
          },
          cfg,
          dispatcher,
        });
        const entry = loadSessionEntry({ storePath, sessionKey: targetSessionKey });
        expect(result).toMatchObject({ queuedFinal: true });
        expect(replies).toEqual([expect.objectContaining({ text })]);
        expect(hookEvents).toEqual([`command:${action}`]);
        expect(entry?.lifecycleRevision).toBeTruthy();
        expect(entry?.lifecycleRevision).not.toBe("before-reset");
      });
    },
  );

  it.each(["thread model", "auth profile"] as const)(
    "applies native %s overrides to the target session",
    async (variant) => {
      await withTempHome(async (home) => {
        const cfg = makeCfg(home);
        const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
        runEmbeddedAgentMock.mockReset();
        const storePath = requireSessionStorePath(cfg);
        const authProfile = variant === "auth profile";
        const slashSessionKey = authProfile
          ? "telegram:slash:111"
          : "agent:main:telegram:slash:7595562691";
        const targetSessionKey = authProfile
          ? MAIN_SESSION_KEY
          : "agent:main:main:thread:7595562691:12812";
        const provider = authProfile ? "openai" : "deepseek";
        const model = authProfile ? "gpt-5.4" : "deepseek-v4-pro";
        if (authProfile) {
          const oauth = (suffix: string) => ({
            type: "oauth" as const,
            provider: "openai",
            access: `oauth-access-token${suffix}`,
            refresh: `oauth-refresh-token${suffix}`,
            expires: Date.now() + 60_000,
          });
          saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                [TEST_PRIMARY_PROFILE_ID]: oauth("-josh"),
                [TEST_SECONDARY_PROFILE_ID]: oauth(""),
              },
              order: {
                openai: [TEST_PRIMARY_PROFILE_ID],
              },
            },
            join(home, ".openclaw", "agents", "main", "agent"),
          );
          await seedTargetSession(storePath, targetSessionKey);
        } else {
          cfg.agents ??= {};
          cfg.agents.defaults ??= {};
          cfg.agents.defaults.models = {
            ...cfg.agents.defaults.models,
            "deepseek/deepseek-v4-pro": {},
          };
          await seedTargetSession(storePath, targetSessionKey, {
            providerOverride: "zai",
            modelOverride: "glm-5.1",
          });
        }

        const res = await getReplyFromConfig(
          makeNativeTelegramCommandMessage({
            body: `/model ${provider}/${model}${authProfile ? `@${TEST_SECONDARY_PROFILE_ID}` : ""}`,
            slashSessionKey,
            targetSessionKey,
          }),
          {},
          cfg,
        );

        expect(maybeReplyText(res)).toContain(
          authProfile
            ? `Auth profile set to ${TEST_SECONDARY_PROFILE_ID}`
            : `Model set to ${provider}/${model}`,
        );
        expect(loadSessionEntry({ storePath, sessionKey: targetSessionKey })).toMatchObject(
          authProfile
            ? { authProfileOverride: TEST_SECONDARY_PROFILE_ID, authProfileOverrideSource: "user" }
            : { providerOverride: provider, modelOverride: model },
        );
        expect(loadExactSessionEntry({ storePath, sessionKey: slashSessionKey })).toBeUndefined();

        runEmbeddedAgentMock.mockReset();
        mockRunEmbeddedAgentOk();
        await getReplyFromConfig(
          { Body: "hi", ...TELEGRAM_DIRECT_MESSAGE, SessionKey: targetSessionKey },
          {},
          cfg,
        );
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
          provider,
          model,
          ...(authProfile
            ? { authProfileId: TEST_SECONDARY_PROFILE_ID, authProfileIdSource: "user" }
            : {}),
        });
      });
    },
  );

  it("enforces reset authorization, strips inline commands, and preserves unauthorized status text", async () => {
    await withTempHome(async (home) => {
      for (const command of ["/new", "/reset"] as const) {
        await expectResetBlockedForNonOwner({ home, command });
      }
      await expectInlineCommandHandledAndStripped({
        home,
        getReplyFromConfig,
        body: "please /whoami now",
        stripToken: "/whoami",
        blockReplyContains: "Identity",
        requestOverrides: { SenderId: "12345" },
      });
      const inlineRunEmbeddedAgentMock = mockRunEmbeddedAgentOk("ok");
      const cfg = makeCfg(home);
      cfg.channels = { ...cfg.channels, whatsapp: { allowFrom: ["+1000"] } };
      const res = await getReplyFromConfig(
        {
          Body: "please /status now",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      expect(maybeReplyText(res)).toBe("ok");
      expect(inlineRunEmbeddedAgentMock).toHaveBeenCalled();
      const prompt = inlineRunEmbeddedAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
      expect(prompt).toContain("/status");
    });
  });

  it("keeps fixture files until asynchronous database custody closes", async () => {
    await withTempHome(async (home) => {
      const markerPath = join(home, "custody.txt");
      await fs.writeFile(markerPath, "retained until close");
      registerOpenClawAgentDatabaseAsyncResource({
        agentId: "main",
        path: join(home, "custody.sqlite"),
        revoke: () => {},
        close: async () => {
          await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("retained until close");
        },
      });
    });
  });
});
