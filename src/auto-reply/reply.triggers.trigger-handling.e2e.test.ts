import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import {
  expectInlineCommandHandledAndStripped,
  getAbortEmbeddedAgentRunMock,
  getCompactEmbeddedAgentSessionMock,
  getRunEmbeddedAgentMock,
  installTriggerHandlingReplyHarness,
  MAIN_SESSION_KEY,
  makeCfg,
  mockRunEmbeddedAgentOk,
  requireSessionStorePath,
  expectBareNewOrResetAcknowledged,
  withTempHome,
} from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { resolveSessionKey } from "../config/sessions.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { registerGroupIntroPromptCases } from "./reply.triggers.group-intro-prompts.cases.js";
import { registerTriggerHandlingUsageSummaryCases } from "./reply.triggers.trigger-handling.filters-usage-summary-current-model-provider.cases.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./reply/queue.js";
import type { MsgContext } from "./templating.js";

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

vi.mock("./reply/commands-compact.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/commands-compact.runtime.js")>()),
  isEmbeddedAgentRunAbortableForCompaction: () => false,
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

function formatDateStampForZone(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function mockRunEmbeddedAgentText(text: string, durationMs: number) {
  const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
  runEmbeddedAgentMock.mockReset();
  runEmbeddedAgentMock.mockResolvedValue({
    payloads: [{ text }],
    meta: {
      durationMs,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  return runEmbeddedAgentMock;
}

async function writeDailyMemoryNotes(
  workspaceDir: string,
  notes: Array<{ stamp: string; text: string }>,
) {
  const memoryDir = join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  for (const note of notes) {
    await fs.writeFile(join(memoryDir, `${note.stamp}.md`), note.text, "utf-8");
  }
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

function makeStartupContextCfg(home: string, reset: boolean) {
  const cfg = makeCfg(home);
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.userTimezone = TEST_TIME_ZONE;
  if (reset) {
    cfg.agents.defaults.startupContext = { applyOn: ["reset"] };
  }
  return cfg;
}

async function runAuthorizedSmsCommand(body: string, cfg: ReturnType<typeof makeCfg>) {
  return await getReplyFromConfig(
    { ...BASE_MESSAGE, Body: body, From: "+1003", CommandAuthorized: true },
    {},
    cfg,
  );
}

function firstMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const arg = mock.mock.calls[0]?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected ${label} first argument`);
  }
  return arg as Record<string, unknown>;
}

function mockSuccessfulCompaction() {
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
}

function makeStoredCfg(home: string, name: string) {
  const cfg = makeCfg(home);
  cfg.session = { ...cfg.session, store: join(home, `${name}.sessions.json`) };
  return cfg;
}

async function expectResetBlockedForNonOwner(params: {
  home: string;
  command: "/new" | "/reset";
}): Promise<void> {
  const { home, command } = params;
  const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
  runEmbeddedAgentMock.mockClear();
  const cfg = makeStoredCfg(home, "blocked-reset");
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
        const workspaceDir = join(home, "openclaw");
        const nowMs = Date.now();
        const todayStamp = formatDateStampForZone(nowMs, TEST_TIME_ZONE);
        const yesterdayStamp = formatDateStampForZone(nowMs - 24 * 60 * 60 * 1000, TEST_TIME_ZONE);
        await writeDailyMemoryNotes(workspaceDir, [
          { stamp: todayStamp, text: "today startup note" },
          { stamp: yesterdayStamp, text: "yesterday startup note" },
        ]);

        const runEmbeddedAgentMock = mockRunEmbeddedAgentText("hello", 1);

        const cfg = makeStartupContextCfg(home, reset);

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
      const runEmbeddedAgentMock = mockRunEmbeddedAgentText("hello", 1);
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
        [
          "heartbeat",
          { Body: "HEARTBEAT /think:high", From: "+1003", To: "+1003" },
          { isHeartbeat: true },
          undefined,
        ],
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
        if (expectedPrompt !== undefined) {
          const prompt =
            firstMockCallArg(runEmbeddedAgentMock, "embedded OpenClaw agent").prompt ?? "";
          expect(prompt, label).toBe(expectedPrompt);
        }
      }
    });
  });

  it("resolves heartbeat model selection from overrides", async () => {
    await withTempHome(async (home) => {
      for (const [label, provider, model] of [
        ["heartbeat-override", "anthropic", "claude-haiku-4-5-20251001"],
        ["stored-override", "openai", "gpt-5.4"],
      ] as const) {
        const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
        runEmbeddedAgentMock.mockReset();
        mockRunEmbeddedAgentOk("ok");
        const cfg = makeCfg(home);
        cfg.session = { ...cfg.session, store: join(home, `${label}.sessions.json`) };
        await seedTargetSession(requireSessionStorePath(cfg), MAIN_SESSION_KEY, {
          sessionId: "main",
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
        });
        if (label === "heartbeat-override") {
          cfg.agents ??= {};
          cfg.agents.defaults ??= {};
          cfg.agents.defaults.heartbeat = { model: `${provider}/${model}` };
        }
        await getReplyFromConfig(BASE_MESSAGE, { isHeartbeat: true }, cfg);

        const call = firstMockCallArg(runEmbeddedAgentMock, "embedded OpenClaw agent");
        expect(call).toMatchObject({ provider, model });
      }
    });
  });

  it.each(["main", "worker"] as const)("compacts the %s session", async (kind) => {
    await withTempHome(async (home) => {
      const cfg = makeStoredCfg(home, `compact-${kind}`);
      const storePath = requireSessionStorePath(cfg);
      const workerSessionKey = "agent:worker1:telegram:12345";
      const request = {
        Body: kind === "main" ? "/compact focus on decisions" : "/compact",
        From: kind === "main" ? "+1003" : "+1004",
        To: "+2000",
        ...(kind === "worker" ? { SessionKey: workerSessionKey } : {}),
      };
      const sessionKey =
        kind === "worker"
          ? workerSessionKey
          : resolveSessionKey("per-sender", request, undefined, "main");
      await seedTargetSession(storePath, sessionKey, { sessionId: `compact-${kind}-session` });
      getCompactEmbeddedAgentSessionMock().mockReset();
      mockSuccessfulCompaction();
      const res = await getReplyFromConfig({ ...request, CommandAuthorized: true }, {}, cfg);
      expect(maybeReplyText(res)).toMatch(/^⚙️ Compacted/u);
      expect(getCompactEmbeddedAgentSessionMock()).toHaveBeenCalledOnce();
      if (kind === "main") {
        expect(loadSessionEntry({ storePath, sessionKey })?.compactionCount).toBe(1);
      } else {
        expect(
          firstMockCallArg(getCompactEmbeddedAgentSessionMock(), "embedded OpenClaw compaction"),
        ).toMatchObject({
          sessionTarget: { agentId: "worker1", sessionKey, storePath },
          sessionFile: sessionKey,
        });
      }
    });
  });

  it("aborts native target sessions and clears queued followups", async () => {
    await withTempHome(async (home) => {
      const cfg = makeStoredCfg(home, "native-stop");
      getAbortEmbeddedAgentRunMock().mockReset().mockReturnValue(false);
      const storePath = requireSessionStorePath(cfg);
      const targetSessionKey = "agent:main:telegram:group:123";
      const targetSessionId = "session-target";
      await seedTargetSession(storePath, targetSessionKey);
      const followupRun: FollowupRun = {
        prompt: "queued",
        enqueuedAt: Date.now(),
        run: {
          agentId: "main",
          agentDir: join(home, "agent"),
          sessionId: targetSessionId,
          sessionKey: targetSessionKey,
          messageProvider: "telegram",
          agentAccountId: "acct",
          sessionFile: join(home, "session.jsonl"),
          workspaceDir: join(home, "workspace"),
          config: cfg,
          provider: "anthropic",
          model: "claude-opus-4-6",
          timeoutMs: 10,
          blockReplyBreak: "text_end",
        },
      };
      enqueueFollowupRun(
        targetSessionKey,
        followupRun,
        { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
        "none",
      );
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(1);

      const native = await vi.importActual<
        typeof import("../agents/embedded-agent-runner/runs.js")
      >("../agents/embedded-agent-runner/runs.js");
      const { createEmbeddedRunHandle } =
        await import("../agents/embedded-agent-runner/runs.test-support.js");
      const abort = vi.fn();
      const handle = createEmbeddedRunHandle({ abort });
      native.setActiveEmbeddedRun(targetSessionId, handle, targetSessionKey, undefined, "main");
      getAbortEmbeddedAgentRunMock().mockImplementation(native.abortEmbeddedAgentRun);
      try {
        const res = await getReplyFromConfig(
          makeNativeTelegramCommandMessage({
            body: "/stop",
            slashSessionKey: "telegram:slash:111",
            targetSessionKey,
          }),
          {},
          cfg,
        );

        expect(maybeReplyText(res)).toBe("⚙️ Agent was aborted.");
        expect(getAbortEmbeddedAgentRunMock()).toHaveBeenCalledWith(targetSessionId);
        expect(abort).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ storePath, sessionKey: targetSessionKey })?.abortedLastRun).toBe(
          true,
        );
        expect(getFollowupQueueDepth(targetSessionKey)).toBe(0);
      } finally {
        native.clearActiveEmbeddedRun(targetSessionId, handle);
        getAbortEmbeddedAgentRunMock().mockReset().mockReturnValue(false);
      }
    });
  });

  it.each(["thread model", "auth profile"] as const)(
    "applies native %s overrides to the target session",
    async (variant) => {
      await withTempHome(async (home) => {
        const cfg = makeStoredCfg(home, "native-model");
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

        mockRunEmbeddedAgentText("ok", 5);
        await getReplyFromConfig(
          { Body: "hi", ...TELEGRAM_DIRECT_MESSAGE, SessionKey: targetSessionKey },
          {},
          cfg,
        );
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(firstMockCallArg(runEmbeddedAgentMock, "embedded OpenClaw agent")).toMatchObject({
          provider,
          model,
          ...(authProfile
            ? { authProfileId: TEST_SECONDARY_PROFILE_ID, authProfileIdSource: "user" }
            : {}),
        });
      });
    },
  );

  it("handles bare session reset, inline commands, and unauthorized inline status", async () => {
    await withTempHome(async (home) => {
      await expectBareNewOrResetAcknowledged({ home, body: "/new", getReplyFromConfig });
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
