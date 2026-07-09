// Covers heartbeat tool-response handling and visible reply policy.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../auto-reply/reply/agent-runner-failure-copy.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce, testing, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedSessionStore,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("heartbeat event previews", () => {
  it("keeps the 200-code-unit preview UTF-16 well-formed", () => {
    expect(testing.truncateHeartbeatPreview(`${"x".repeat(199)}🚀tail`)).toBe("x".repeat(199));
    expect(testing.truncateHeartbeatPreview(undefined)).toBeUndefined();
  });
});

describe("runHeartbeatOnce heartbeat response tool", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  afterEach(() => {
    vi.unstubAllEnvs();
    resetHeartbeatEventsForTest();
  });

  function createConfig(params: {
    tmpDir: string;
    storePath: string;
    visibleReplies?: "automatic" | "message_tool";
    groupVisibleReplies?: "automatic" | "message_tool";
    agentRuntimeId?: string;
    modelRuntimeId?: string;
    model?: string;
    isolatedSession?: boolean;
    operationalReplies?: {
      policy: "always" | "once" | "redirect" | "silent";
      redirectSessionKey?: string;
    };
    includeReasoning?: boolean;
    target?: "telegram" | "last";
    showOk?: boolean;
  }): OpenClawConfig {
    const messages =
      params.visibleReplies || params.groupVisibleReplies || params.operationalReplies
        ? {
            ...(params.visibleReplies ? { visibleReplies: params.visibleReplies } : {}),
            ...(params.groupVisibleReplies
              ? { groupChat: { visibleReplies: params.groupVisibleReplies } }
              : {}),
            ...(params.operationalReplies ? { operationalReplies: params.operationalReplies } : {}),
          }
        : undefined;
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
            ...(params.isolatedSession ? { isolatedSession: true } : {}),
            ...(params.includeReasoning ? { includeReasoning: true } : {}),
          },
          ...(params.model ? { model: params.model } : {}),
          ...(params.model && params.modelRuntimeId
            ? { models: { [params.model]: { agentRuntime: { id: params.modelRuntimeId } } } }
            : {}),
          ...(params.agentRuntimeId ? { agentRuntime: { id: params.agentRuntimeId } } : {}),
        },
      },
      ...(messages ? { messages } : {}),
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: params.showOk ?? false },
        },
      },
      session: { store: params.storePath },
    } as OpenClawConfig;
  }

  function createDeps(params: {
    sendTelegram: ReturnType<typeof vi.fn>;
    getReplyFromConfig: HeartbeatDeps["getReplyFromConfig"];
    extra?: Partial<HeartbeatDeps>;
  }): HeartbeatDeps {
    return {
      telegram: params.sendTelegram as unknown,
      getQueueSize: () => 0,
      nowMs: () => 0,
      getReplyFromConfig: params.getReplyFromConfig,
      ...params.extra,
    };
  }

  function expectTelegramSend(
    sendTelegram: ReturnType<typeof vi.fn>,
    params: { text: string; cfg: OpenClawConfig; silent?: boolean },
  ) {
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls).toEqual([
      [
        TELEGRAM_GROUP,
        params.text,
        {
          verbose: false,
          cfg: params.cfg,
          accountId: undefined,
          ...(params.silent !== undefined ? { silent: params.silent } : {}),
        },
      ],
    ]);
  }

  function replyCall(replySpy: ReturnType<typeof vi.fn>): unknown[] {
    const call = replySpy.mock.calls[0];
    if (!call) {
      throw new Error("Expected reply call");
    }
    return call;
  }

  function replyContext(replySpy: ReturnType<typeof vi.fn>): {
    Body?: string;
    SessionKey?: string;
  } {
    const context = replyCall(replySpy)[0];
    if (!context || typeof context !== "object") {
      throw new Error("Expected reply context");
    }
    return context as { Body?: string; SessionKey?: string };
  }

  function replyOptions(replySpy: ReturnType<typeof vi.fn>): {
    enableHeartbeatTool?: boolean;
    forceHeartbeatTool?: boolean;
    sourceReplyDeliveryMode?: string;
  } {
    const options = replyCall(replySpy)[1];
    if (!options || typeof options !== "object") {
      throw new Error("Expected reply options");
    }
    return options as {
      enableHeartbeatTool?: boolean;
      forceHeartbeatTool?: boolean;
      sourceReplyDeliveryMode?: string;
    };
  }

  async function runWithToolResponse(response: HeartbeatToolResponse) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue(createHeartbeatToolResponsePayload(response));
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      return { result, sendTelegram, replySpy, cfg };
    });
  }

  async function runPlainFallbackReply(text: string, options: { showOk?: boolean } = {}) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, showOk: options.showOk });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue({ text });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      return { result, sendTelegram, replySpy, cfg };
    });
  }

  async function runPromptScenario(
    params: {
      config?: Partial<Parameters<typeof createConfig>[0]>;
      session?: Partial<Parameters<typeof seedMainSessionStore>[2]>;
      beforeSeed?: (params: {
        tmpDir: string;
        storePath: string;
        cfg: OpenClawConfig;
      }) => Promise<void>;
    } = {},
  ) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, ...params.config });
      await params.beforeSeed?.({ tmpDir, storePath, cfg });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        ...params.session,
      });
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      return {
        calledCtx: replyContext(replySpy),
        calledOpts: replyOptions(replySpy),
      };
    });
  }

  function expectHeartbeatToolPrompt(
    result: Awaited<ReturnType<typeof runPromptScenario>>,
    extraBodyText: string[] = [],
  ) {
    for (const text of extraBodyText) {
      expect(result.calledCtx.Body).toContain(text);
    }
    expect(result.calledCtx.Body).toContain("heartbeat_respond");
    expect(result.calledCtx.Body).not.toContain("HEARTBEAT_OK");
    expect(result.calledOpts.enableHeartbeatTool).toBe(true);
    expect(result.calledOpts.forceHeartbeatTool).toBe(true);
    expect(result.calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
  }

  it("treats notify=false as a quiet heartbeat ack", async () => {
    const { result, sendTelegram } = await runWithToolResponse({
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("delivers notificationText when notify=true", async () => {
    const { sendTelegram, cfg } = await runWithToolResponse({
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    });

    expectTelegramSend(sendTelegram, {
      text: "Build is blocked on missing credentials.",
      cfg,
    });
  });

  it.each(["", "\n", "\r\n"])(
    "converts trailing notify=false fallback text into silent Telegram delivery with suffix %j",
    async (suffix) => {
      const { result, sendTelegram, cfg } = await runPlainFallbackReply(
        `No interruption needed.\n\nnotify=false${suffix}`,
      );

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, {
        text: "No interruption needed.",
        cfg,
        silent: true,
      });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "sent",
        preview: "No interruption needed.",
        channel: "telegram",
        silent: true,
      });
    },
  );

  it("suppresses marker-only notify=false fallback replies", async () => {
    const { result, sendTelegram } = await runPlainFallbackReply("notify=false\r\n", {
      showOk: true,
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "ok-token",
      channel: "telegram",
      silent: true,
    });
  });

  it("preserves inline notify=false fallback text", async () => {
    const { result, sendTelegram, cfg } = await runPlainFallbackReply(
      "The literal notify=false flag is documented.",
    );

    expect(result.status).toBe("ran");
    expectTelegramSend(sendTelegram, {
      text: "The literal notify=false flag is documented.",
      cfg,
    });
  });

  it("uses the heartbeat response tool prompt in message-tool mode", async () => {
    const result = await runPromptScenario({
      config: { visibleReplies: "message_tool" },
    });

    expectHeartbeatToolPrompt(result, ["notify=false"]);
  });

  it("uses the heartbeat response tool prompt for group message-tool mode", async () => {
    const result = await runPromptScenario({
      config: { groupVisibleReplies: "message_tool", target: "last" },
      session: { lastTo: "group:redacted" },
    });

    expectHeartbeatToolPrompt(result, ["notify=false"]);
  });

  it("uses the heartbeat response tool prompt for the default Codex runtime", async () => {
    const result = await runPromptScenario();

    expectHeartbeatToolPrompt(result);
  });

  it.each([
    {
      name: "uses the isolated Codex runtime instead of the base OpenClaw runtime",
      config: { isolatedSession: true },
      session: {
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        agentRuntimeOverride: "openclaw",
      },
      expectedToolPrompt: true,
    },
    {
      name: "uses the isolated OpenClaw runtime instead of the base Codex runtime",
      config: {
        isolatedSession: true,
        model: "anthropic/claude-sonnet-4-6",
      },
      session: {
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        agentRuntimeOverride: "codex",
      },
      expectedToolPrompt: false,
    },
  ])("$name", async ({ config, session, expectedToolPrompt }) => {
    const result = await runPromptScenario({ config, session });

    expect(result.calledCtx.SessionKey).toMatch(/:heartbeat$/);
    if (expectedToolPrompt) {
      expectHeartbeatToolPrompt(result);
      return;
    }
    expect(result.calledCtx.Body).toContain("HEARTBEAT_OK");
    expect(result.calledCtx.Body).not.toContain("heartbeat_respond");
    expect(result.calledOpts.sourceReplyDeliveryMode).toBeUndefined();
  });

  it.each([
    ["observational harness id", { agentHarnessId: "codex" }],
    ["provider-incompatible override", { agentRuntimeOverride: "codex" }],
  ])("does not let a %s select the next heartbeat runtime", async (_label, session) => {
    const result = await runPromptScenario({
      config: { model: "anthropic/claude-sonnet-4-6" },
      session,
    });

    expect(result.calledCtx.Body).toContain("HEARTBEAT_OK");
    expect(result.calledCtx.Body).not.toContain("heartbeat_respond");
    expect(result.calledOpts.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("delivers Codex runtime failure notices during Codex heartbeat message-tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        agentHarnessId: "codex",
      });
      const usageLimitMessage =
        "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: usageLimitMessage,
          isError: true,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      const calledOpts = replyOptions(replySpy);
      expect(result.status).toBe("ran");
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
      expectTelegramSend(sendTelegram, {
        text: usageLimitMessage,
        cfg,
      });
    });
  });

  it("silences Codex runtime failure heartbeat notices when operational replies are silent", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        tmpDir,
        storePath,
        operationalReplies: { policy: "silent" },
      });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        agentHarnessId: "codex",
      });
      const usageLimitMessage =
        "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes.";
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: usageLimitMessage,
          isError: true,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "operational-replies",
        channel: "telegram",
      });
    });
  });

  it("does not record suppressed heartbeat main notices when only reasoning is sent", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        tmpDir,
        storePath,
        includeReasoning: true,
        operationalReplies: { policy: "silent" },
      });
      const sourceSessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        agentHarnessId: "codex",
      });
      const usageLimitMessage =
        "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes.";
      replySpy.mockResolvedValue([
        { text: "checking limits", isReasoning: true },
        markReplyPayloadForSourceSuppressionDelivery({
          text: usageLimitMessage,
          isError: true,
        }),
      ]);
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram.mock.calls[0]?.[1]).toContain("checking limits");
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { lastHeartbeatText?: string }
      >;
      expect(store[sourceSessionKey]?.lastHeartbeatText).toBeUndefined();
    });
  });

  it("redirects heartbeat notices before checking source channel readiness", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        tmpDir,
        storePath,
        target: "last",
        operationalReplies: {
          policy: "redirect",
          redirectSessionKey: "agent:main:ops",
        },
      });
      const sourceSessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
        agentHarnessId: "codex",
      });
      await seedSessionStore(storePath, "agent:main:ops", {
        sessionId: "ops-session",
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      const usageLimitMessage =
        "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes.";
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: usageLimitMessage,
          isError: true,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1" });
      const webAuthExists = vi.fn(async () => false);

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({
          sendTelegram,
          getReplyFromConfig: replySpy,
          extra: {
            whatsapp: sendWhatsApp,
            webAuthExists,
          },
        }),
      });

      expect(result.status).toBe("ran");
      expect(webAuthExists).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "operational-replies",
        channel: "whatsapp",
      });
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
      const redirectedEntry = store["agent:main:ops"] as { sessionFile?: string } | undefined;
      const redirectedEntryText = redirectedEntry?.sessionFile
        ? await fs.readFile(redirectedEntry.sessionFile, "utf-8")
        : JSON.stringify(redirectedEntry);
      expect(redirectedEntryText).toContain(usageLimitMessage);
      expect(redirectedEntryText).toContain(sourceSessionKey);
      expect(redirectedEntryText).toContain("whatsapp");
      expect(redirectedEntryText).toContain("heartbeat");
    });
  });

  it("rewrites foreground generic runner failure payloads before heartbeat delivery", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, {
        text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
        cfg,
      });
      expect(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT).not.toContain("/new");
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-runner-failure",
        preview: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
        channel: "telegram",
      });
    });
  });

  it("suppresses internal stream-error fallback placeholders before heartbeat delivery", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: `${STREAM_ERROR_FALLBACK_TEXT}\n${STREAM_ERROR_FALLBACK_TEXT}`,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "ok-token",
        channel: "telegram",
        silent: true,
      });
    });
  });

  it("uses the heartbeat response tool prompt for auto-selected Codex model sessions", async () => {
    const result = await runPromptScenario({
      config: {
        agentRuntimeId: "auto",
        model: "openai/gpt-5.5",
      },
    });

    expectHeartbeatToolPrompt(result);
  });

  it("uses the heartbeat response tool prompt for model-specific Codex runtimes", async () => {
    const result = await runPromptScenario({
      config: {
        model: "openai/gpt-5.5",
        modelRuntimeId: "codex",
      },
    });

    expectHeartbeatToolPrompt(result);
  });

  it("honors model-specific non-Codex runtimes over default Codex heartbeat mode", async () => {
    const result = await runPromptScenario({
      config: {
        agentRuntimeId: "codex",
        model: "openai/gpt-5.5",
        modelRuntimeId: "native",
      },
    });

    expect(result.calledCtx.Body).toContain("HEARTBEAT_OK");
    expect(result.calledCtx.Body).not.toContain("heartbeat_respond");
    expect(result.calledOpts.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("uses the heartbeat response tool prompt when the Codex runtime is env-forced", async () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "codex");
    const result = await runPromptScenario({
      config: { model: "openai/gpt-5.5" },
    });

    expectHeartbeatToolPrompt(result);
  });

  it("uses the heartbeat response tool prompt for due heartbeat tasks", async () => {
    const result = await runPromptScenario({
      config: { visibleReplies: "message_tool" },
      beforeSeed: async ({ tmpDir }) => {
        await fs.writeFile(
          path.join(tmpDir, "HEARTBEAT.md"),
          `tasks:
  - name: status
    interval: 1m
    prompt: Check deployment status
`,
          "utf-8",
        );
      },
    });

    expectHeartbeatToolPrompt(result, [
      "Run the following periodic tasks",
      "Check deployment status",
    ]);
  });

  it("keeps the legacy heartbeat ok prompt outside heartbeat response tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "automatic" });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      const calledCtx = replyContext(replySpy);
      const calledOpts = replyOptions(replySpy);
      expect(calledCtx.Body).toContain("HEARTBEAT_OK");
      expect(calledCtx.Body).not.toContain("heartbeat_respond");
      expect(calledOpts.enableHeartbeatTool).toBeUndefined();
      expect(calledOpts.forceHeartbeatTool).toBeUndefined();
      expect(calledOpts.sourceReplyDeliveryMode).toBeUndefined();
    });
  });
});
