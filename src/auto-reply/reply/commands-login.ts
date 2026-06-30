/** Handles channel-native Codex/OpenAI login commands. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  runModelsAuthLoginFlow,
  type ModelsAuthLoginFlowOptions,
} from "../../commands/models/auth.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const CODEX_LOGIN_PROVIDER = "openai";
const CODEX_LOGIN_METHOD = "device-code";
const CODEX_LOGIN_FLOW_TTL_MS = 15 * 60_000;
const CODEX_LOGIN_PROVIDER_ALIASES = new Set(["codex", "openai", "openai-codex"]);

type CodexLoginFlowRecord = {
  expiresAt: number;
};

const activeCodexLoginFlows = new Map<string, CodexLoginFlowRecord>();

type RunLoginFlow = (opts: ModelsAuthLoginFlowOptions) => Promise<unknown>;

function parseLoginCommand(commandBodyNormalized: string): { providerInput: string } | null {
  const match = commandBodyNormalized.trim().match(/^\/login(?:\s+(.+))?$/u);
  if (!match) {
    return null;
  }
  const providerInput = match[1]?.trim() || "codex";
  return { providerInput };
}

function resolveCodexLoginProvider(rawProvider: string | undefined): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(rawProvider ?? "codex").replace(/_/gu, "-");
  if (!normalized) {
    return CODEX_LOGIN_PROVIDER;
  }
  return CODEX_LOGIN_PROVIDER_ALIASES.has(normalized) ? CODEX_LOGIN_PROVIDER : null;
}

function keyPart(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function buildCodexLoginFlowKey(params: HandleCommandsParams, provider: string): string {
  const threadId =
    params.ctx.MessageThreadId ?? params.ctx.TransportThreadId ?? params.ctx.ThreadParentId;
  return [
    "channel-login",
    keyPart(params.command.channel || params.ctx.Surface || params.ctx.Provider, "unknown"),
    keyPart(params.command.accountId ?? params.ctx.AccountId, "default"),
    keyPart(params.ctx.OriginatingTo ?? params.command.to ?? params.command.channelId, "unknown"),
    keyPart(threadId, "main"),
    keyPart(
      params.agentId ??
        resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
      "main",
    ),
    provider,
  ].join(":");
}

function resolveLoginAgentId(params: HandleCommandsParams): string | undefined {
  return (
    normalizeOptionalString(params.agentId) ??
    (params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : undefined)
  );
}

function buildLoginPrompter(params: {
  sendMessage: (text: string) => Promise<void>;
}): ModelsAuthLoginFlowOptions["prompter"] {
  const sendCleanMessage = async (message: string) => {
    const text = message.trim();
    if (text) {
      await params.sendMessage(text);
    }
  };
  const unsupportedPrompt = async () => {
    throw new Error("Channel /login supports only fixed Codex device-code auth.");
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      await sendCleanMessage([title?.trim(), message.trim()].filter(Boolean).join("\n\n"));
    },
    plain: sendCleanMessage,
    select: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["select"],
    multiselect: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["multiselect"],
    text: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["text"],
    confirm: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["confirm"],
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function buildFinalReply(params: { emittedMessages: string[]; status: string }): ReplyPayload {
  const prefix = params.emittedMessages.map((message) => message.trim()).filter(Boolean);
  return {
    text: [...prefix, params.status].join("\n\n"),
  };
}

async function emitLoginMessage(
  params: HandleCommandsParams,
  emittedMessages: string[],
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (params.opts?.onBlockReply) {
    await params.opts.onBlockReply({ text: trimmed });
    return;
  }
  emittedMessages.push(trimmed);
}

async function runChannelCodexLogin(params: {
  commandParams: HandleCommandsParams;
  provider: string;
  agentId: string;
  runLoginFlow?: RunLoginFlow;
  runtime?: RuntimeEnv;
}): Promise<ReplyPayload> {
  const flowKey = buildCodexLoginFlowKey(params.commandParams, params.provider);
  const now = Date.now();
  const activeFlow = activeCodexLoginFlows.get(flowKey);
  if (activeFlow && activeFlow.expiresAt > now) {
    return {
      text: "A Codex login code is already active for this chat or channel. Complete it, or wait for it to expire before requesting a new one.",
    };
  }
  if (activeFlow) {
    activeCodexLoginFlows.delete(flowKey);
  }

  const emittedMessages: string[] = [];
  const flowRecord = { expiresAt: now + CODEX_LOGIN_FLOW_TTL_MS };
  activeCodexLoginFlows.set(flowKey, flowRecord);
  try {
    await (params.runLoginFlow ?? runModelsAuthLoginFlow)({
      provider: params.provider,
      method: CODEX_LOGIN_METHOD,
      agent: params.agentId,
      config: params.commandParams.cfg,
      runtime: params.runtime ?? defaultRuntime,
      prompter: buildLoginPrompter({
        sendMessage: async (text) =>
          await emitLoginMessage(params.commandParams, emittedMessages, text),
      }),
      isRemote: true,
      openUrl: async () => {},
    });
    return buildFinalReply({
      emittedMessages,
      status: "Codex login complete. Try your request again now.",
    });
  } catch {
    return buildFinalReply({
      emittedMessages,
      status: "Codex login did not complete. Send `/login codex` to request a new code.",
    });
  } finally {
    if (activeCodexLoginFlows.get(flowKey) === flowRecord) {
      activeCodexLoginFlows.delete(flowKey);
    }
  }
}

export const handleLoginCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseLoginCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender || !params.command.senderIsOwner) {
    return {
      shouldContinue: false,
      reply: { text: "Only an OpenClaw owner/admin can start Codex login from this channel." },
    };
  }

  const provider = resolveCodexLoginProvider(parsed.providerInput);
  if (!provider) {
    return {
      shouldContinue: false,
      reply: { text: "Unsupported login provider. Use `/login codex`." },
    };
  }

  const agentId = resolveLoginAgentId(params);
  if (!agentId) {
    return {
      shouldContinue: false,
      reply: {
        text: "Codex login is unavailable because the active agent could not be resolved.",
      },
    };
  }

  const reply = await runChannelCodexLogin({
    commandParams: params,
    provider,
    agentId,
  });
  return { shouldContinue: false, reply };
};

export const testing = {
  clearActiveFlows() {
    activeCodexLoginFlows.clear();
  },
  resolveCodexLoginProvider,
};
