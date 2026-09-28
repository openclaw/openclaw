// Shared ACP command helpers for session identity and reply formatting.
import { randomUUID } from "node:crypto";
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import type { Result } from "@openclaw/normalization-core/result";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { type AcpRuntimeError, toAcpRuntimeErrorText } from "../../../acp/runtime/errors.js";
import { supportsAutomaticThreadBindingSpawn } from "../../../channels/thread-bindings-policy.js";
import type { AcpSessionRuntimeOptions } from "../../../config/sessions/types.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandChannel, resolveAcpCommandThreadId } from "./context.js";

export const COMMAND = "/acp";
const ACP_SPAWN_USAGE =
  "Usage: /acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>].";
const ACP_STEER_USAGE =
  "Usage: /acp steer [--session <session-key|session-id|session-label>] <instruction>";
export const ACP_SET_MODE_USAGE =
  "Usage: /acp set-mode <mode> [session-key|session-id|session-label]";
const ACP_SET_USAGE = "Usage: /acp set <key> <value> [session-key|session-id|session-label]";
export const ACP_CWD_USAGE = "Usage: /acp cwd <path> [session-key|session-id|session-label]";
export const ACP_PERMISSIONS_USAGE =
  "Usage: /acp permissions <profile> [session-key|session-id|session-label]";
export const ACP_TIMEOUT_USAGE =
  "Usage: /acp timeout <seconds> [session-key|session-id|session-label]";
export const ACP_MODEL_USAGE =
  "Usage: /acp model <model-id> [session-key|session-id|session-label]";
export const ACP_RESET_OPTIONS_USAGE =
  "Usage: /acp reset-options [session-key|session-id|session-label]";
export const ACP_STATUS_USAGE = "Usage: /acp status [session-key|session-id|session-label]";
export const ACP_INSTALL_USAGE = "Usage: /acp install";
export const ACP_DOCTOR_USAGE = "Usage: /acp doctor";
export const ACP_SESSIONS_USAGE = "Usage: /acp sessions";
export const ACP_STEER_OUTPUT_LIMIT = 800;
type AcpSpawnThreadMode = "auto" | "here" | "off";
type AcpSpawnBindMode = "here" | "off";

type ParsedSpawnInput = {
  agentId: string;
  mode: AcpRuntimeSessionMode;
  thread: AcpSpawnThreadMode;
  bind: AcpSpawnBindMode;
  cwd?: string;
  label?: string;
};

type ParsedSteerInput = {
  sessionToken?: string;
  instruction: string;
};

type ParsedSingleValueCommandInput = {
  value: string;
  sessionToken?: string;
};

type ParsedSetCommandInput = {
  key: string;
  value: string;
  sessionToken?: string;
};

const ACP_UNICODE_DASH_PREFIX_RE =
  /^[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]+/;

function readOptionValue(params: { tokens: string[]; index: number; flags: readonly string[] }):
  | {
      matched: true;
      flag: string;
      value?: string;
      nextIndex: number;
      error?: string;
    }
  | { matched: false } {
  const token = normalizeAcpOptionToken(params.tokens[params.index] ?? "");
  const flag = params.flags.find(
    (candidate) => token === candidate || token.startsWith(`${candidate}=`),
  );
  if (!flag) {
    return { matched: false };
  }
  let value: string;
  let nextIndex = params.index + 1;
  if (token === flag) {
    const nextValue = normalizeAcpOptionToken(params.tokens[params.index + 1] ?? "");
    value = nextValue.startsWith("--") ? "" : nextValue;
    if (value) {
      nextIndex += 1;
    }
  } else {
    value = token.slice(flag.length + 1).trim();
  }
  if (!value) {
    return {
      matched: true,
      flag,
      nextIndex,
      error: `${flag} requires a value`,
    };
  }
  return { matched: true, flag, value, nextIndex };
}

function normalizeAcpOptionToken(raw: string): string {
  const token = raw.trim();
  if (!token || token.startsWith("--")) {
    return token;
  }
  const dashPrefix = token.match(ACP_UNICODE_DASH_PREFIX_RE)?.[0];
  if (!dashPrefix) {
    return token;
  }
  return `--${token.slice(dashPrefix.length)}`;
}

function resolveDefaultSpawnThreadMode(params: HandleCommandsParams): AcpSpawnThreadMode {
  const channel = resolveAcpCommandChannel(params);
  if (!supportsAutomaticThreadBindingSpawn(channel)) {
    return "off";
  }
  const currentThreadId = resolveAcpCommandThreadId(params);
  return currentThreadId ? "here" : "auto";
}

export function parseSpawnInput(
  params: HandleCommandsParams,
  tokens: string[],
): Result<ParsedSpawnInput, string> {
  const normalizedTokens = tokens.map((token) => normalizeAcpOptionToken(token));
  let mode: AcpRuntimeSessionMode = "persistent";
  let thread = resolveDefaultSpawnThreadMode(params);
  let sawThreadOption = false;
  let bind: AcpSpawnBindMode = "off";
  let cwd: string | undefined;
  let label: string | undefined;
  let rawAgentId: string | undefined;

  for (let i = 0; i < normalizedTokens.length;) {
    const token = normalizedTokens[i] ?? "";

    const option = readOptionValue({
      tokens: normalizedTokens,
      index: i,
      flags: ["--mode", "--bind", "--thread", "--cwd", "--label"],
    });
    if (option.matched) {
      if (option.error) {
        return { ok: false, error: `${option.error}. ${ACP_SPAWN_USAGE}` };
      }
      const raw = normalizeOptionalLowercaseString(option.value);
      switch (option.flag) {
        case "--mode":
          if (raw !== "persistent" && raw !== "oneshot") {
            return {
              ok: false,
              error: `Invalid --mode value "${option.value}". Use persistent or oneshot.`,
            };
          }
          mode = raw;
          break;
        case "--bind":
          if (raw !== "here" && raw !== "off") {
            return {
              ok: false,
              error: `Invalid --bind value "${option.value}". Use here or off.`,
            };
          }
          bind = raw;
          break;
        case "--thread":
          if (raw !== "auto" && raw !== "here" && raw !== "off") {
            return {
              ok: false,
              error: `Invalid --thread value "${option.value}". Use auto, here, or off.`,
            };
          }
          thread = raw;
          sawThreadOption = true;
          break;
        case "--cwd":
          cwd = normalizeOptionalString(option.value);
          break;
        case "--label":
          label = normalizeOptionalString(option.value);
          break;
      }
      i = option.nextIndex;
      continue;
    }

    if (token.startsWith("--")) {
      return {
        ok: false,
        error: `Unknown option: ${token}. ${ACP_SPAWN_USAGE}`,
      };
    }

    if (!rawAgentId) {
      rawAgentId = normalizeOptionalString(token);
      i += 1;
      continue;
    }

    return {
      ok: false,
      error: `Unexpected argument: ${token}. ${ACP_SPAWN_USAGE}`,
    };
  }

  const fallbackAgent = normalizeOptionalString(params.cfg.acp?.defaultAgent) ?? "";
  const selectedAgent = normalizeOptionalString(rawAgentId) ?? fallbackAgent;
  if (!selectedAgent) {
    return {
      ok: false,
      error: `ACP target harness id is required. Pass an ACP harness id (for example codex) or configure acp.defaultAgent. ${ACP_SPAWN_USAGE}`,
    };
  }
  const normalizedAgentId = normalizeAgentId(selectedAgent);
  if (bind !== "off" && !sawThreadOption) {
    thread = "off";
  }
  if (thread !== "off" && bind !== "off") {
    return {
      ok: false,
      error: `Use either --thread or --bind for /acp spawn, not both. ${ACP_SPAWN_USAGE}`,
    };
  }

  return {
    ok: true,
    value: {
      agentId: normalizedAgentId,
      mode,
      thread,
      bind,
      cwd,
      label,
    },
  };
}

export function parseSteerInput(tokens: string[]): Result<ParsedSteerInput, string> {
  const normalizedTokens = tokens.map((token) => normalizeAcpOptionToken(token));
  let sessionToken: string | undefined;
  const instructionTokens: string[] = [];

  for (let i = 0; i < normalizedTokens.length;) {
    const sessionOption = readOptionValue({
      tokens: normalizedTokens,
      index: i,
      flags: ["--session"],
    });
    if (sessionOption.matched) {
      if (sessionOption.error) {
        return {
          ok: false,
          error: `${sessionOption.error}. ${ACP_STEER_USAGE}`,
        };
      }
      sessionToken = normalizeOptionalString(sessionOption.value);
      i = sessionOption.nextIndex;
      continue;
    }

    instructionTokens.push(tokens[i] ?? "");
    i += 1;
  }

  const instruction = instructionTokens.join(" ").trim();
  if (!instruction) {
    return {
      ok: false,
      error: ACP_STEER_USAGE,
    };
  }

  return {
    ok: true,
    value: {
      sessionToken,
      instruction,
    },
  };
}

export function parseSingleValueCommandInput(
  tokens: string[],
  usage: string,
): Result<ParsedSingleValueCommandInput, string> {
  const value = normalizeOptionalString(tokens[0]) ?? "";
  if (!value) {
    return { ok: false, error: usage };
  }
  if (tokens.length > 2) {
    return { ok: false, error: usage };
  }
  const sessionToken = normalizeOptionalString(tokens[1]);
  return {
    ok: true,
    value: {
      value,
      sessionToken,
    },
  };
}

export function parseSetCommandInput(tokens: string[]): Result<ParsedSetCommandInput, string> {
  const key = normalizeOptionalString(tokens[0]) ?? "";
  const value = normalizeOptionalString(tokens[1]) ?? "";
  if (!key || !value) {
    return {
      ok: false,
      error: ACP_SET_USAGE,
    };
  }
  if (tokens.length > 3) {
    return {
      ok: false,
      error: ACP_SET_USAGE,
    };
  }
  const sessionToken = normalizeOptionalString(tokens[2]);
  return {
    ok: true,
    value: {
      key,
      value,
      sessionToken,
    },
  };
}

export function parseOptionalSingleTarget(
  tokens: string[],
  usage: string,
): { ok: true; sessionToken?: string } | { ok: false; error: string } {
  if (tokens.length > 1) {
    return { ok: false, error: usage };
  }
  const token = normalizeOptionalString(tokens[0]) ?? "";
  return {
    ok: true,
    ...(token ? { sessionToken: token } : {}),
  };
}

export function resolveAcpHelpText(): string {
  return [
    "ACP commands:",
    "-----",
    "/acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>]",
    "/acp cancel [session-key|session-id|session-label]",
    "/acp steer [--session <session-key|session-id|session-label>] <instruction>",
    "/acp close [session-key|session-id|session-label]",
    "/acp status [session-key|session-id|session-label]",
    "/acp set-mode <mode> [session-key|session-id|session-label]",
    "/acp set <key> <value> [session-key|session-id|session-label]",
    "/acp cwd <path> [session-key|session-id|session-label]",
    "/acp permissions <profile> [session-key|session-id|session-label]",
    "/acp timeout <seconds> [session-key|session-id|session-label]",
    "/acp model <model-id> [session-key|session-id|session-label]",
    "/acp reset-options [session-key|session-id|session-label]",
    "/acp doctor",
    "/acp install",
    "/acp sessions",
    "",
    "Notes:",
    "- /acp spawn harness-id is an ACP runtime harness alias (for example codex), not an OpenClaw agents.list id.",
    "- Use --bind here to pin the current conversation to the ACP session without creating a child thread.",
    "- /session unbind detaches this conversation without closing its ACP session.",
    "- ACP dispatch of normal thread messages is controlled by acp.dispatch.enabled.",
  ].join("\n");
}

export function formatRuntimeOptionsText(options: AcpSessionRuntimeOptions): string {
  const extras = options.backendExtras
    ? Object.entries(options.backendExtras)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")
    : "";
  const parts = [
    options.runtimeMode ? `runtimeMode=${options.runtimeMode}` : null,
    options.model ? `model=${options.model}` : null,
    options.thinking ? `thinking=${options.thinking}` : null,
    options.cwd ? `cwd=${options.cwd}` : null,
    options.permissionProfile ? `permissionProfile=${options.permissionProfile}` : null,
    typeof options.timeoutSeconds === "number" ? `timeoutSeconds=${options.timeoutSeconds}` : null,
    extras ? `extras={${extras}}` : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) {
    return "(none)";
  }
  return parts.join(", ");
}

export function formatAcpCapabilitiesText(controls: string[]): string {
  if (controls.length === 0) {
    return "(none)";
  }
  return controls.toSorted().join(", ");
}

export function resolveCommandRequestId(params: HandleCommandsParams): string {
  const value =
    params.ctx.MessageSidFull ??
    params.ctx.MessageSid ??
    params.ctx.MessageSidFirst ??
    params.ctx.MessageSidLast;
  if (typeof value === "string") {
    const normalizedValue = normalizeOptionalString(value);
    if (normalizedValue) {
      return normalizedValue;
    }
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return randomUUID();
}

export async function withAcpCommandErrorBoundary<T>(params: {
  run: () => Promise<T>;
  fallbackCode: AcpRuntimeError["code"];
  fallbackMessage: string;
  onSuccess: (value: T) => CommandHandlerResult;
}): Promise<CommandHandlerResult> {
  try {
    const result = await params.run();
    return params.onSuccess(result);
  } catch (error) {
    return commandReply(
      toAcpRuntimeErrorText({
        error,
        fallbackCode: params.fallbackCode,
        fallbackMessage: params.fallbackMessage,
      }),
    );
  }
}
