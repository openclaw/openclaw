import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { toAcpRuntimeErrorText } from "../../../acp/runtime/error-text.js";
import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveAcpCommandChannel, resolveAcpCommandThreadId } from "./context.js";
export const COMMAND = "/acp";
export const ACP_SPAWN_USAGE = "Usage: /acp spawn [agentId] [--mode persistent|oneshot] [--thread auto|here|off] [--cwd <path>] [--label <label>].";
export const ACP_STEER_USAGE = "Usage: /acp steer [--session <session-key|session-id|session-label>] <instruction>";
export const ACP_SET_MODE_USAGE = "Usage: /acp set-mode <mode> [session-key|session-id|session-label]";
export const ACP_SET_USAGE = "Usage: /acp set <key> <value> [session-key|session-id|session-label]";
export const ACP_CWD_USAGE = "Usage: /acp cwd <path> [session-key|session-id|session-label]";
export const ACP_PERMISSIONS_USAGE = "Usage: /acp permissions <profile> [session-key|session-id|session-label]";
export const ACP_TIMEOUT_USAGE = "Usage: /acp timeout <seconds> [session-key|session-id|session-label]";
export const ACP_MODEL_USAGE = "Usage: /acp model <model-id> [session-key|session-id|session-label]";
export const ACP_RESET_OPTIONS_USAGE = "Usage: /acp reset-options [session-key|session-id|session-label]";
export const ACP_STATUS_USAGE = "Usage: /acp status [session-key|session-id|session-label]";
export const ACP_INSTALL_USAGE = "Usage: /acp install";
export const ACP_DOCTOR_USAGE = "Usage: /acp doctor";
export const ACP_SESSIONS_USAGE = "Usage: /acp sessions";
export const ACP_STEER_OUTPUT_LIMIT = 800;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function stopWithText(text) {
    return {
        shouldContinue: false,
        reply: { text },
    };
}
export function resolveAcpAction(tokens) {
    const action = tokens[0]?.trim().toLowerCase();
    if (action === "spawn" ||
        action === "cancel" ||
        action === "steer" ||
        action === "close" ||
        action === "sessions" ||
        action === "status" ||
        action === "set-mode" ||
        action === "set" ||
        action === "cwd" ||
        action === "permissions" ||
        action === "timeout" ||
        action === "model" ||
        action === "reset-options" ||
        action === "doctor" ||
        action === "install" ||
        action === "help") {
        tokens.shift();
        return action;
    }
    return "help";
}
function readOptionValue(params) {
    const token = params.tokens[params.index] ?? "";
    if (token === params.flag) {
        const nextValue = params.tokens[params.index + 1]?.trim() ?? "";
        if (!nextValue || nextValue.startsWith("--")) {
            return {
                matched: true,
                nextIndex: params.index + 1,
                error: `${params.flag} requires a value`,
            };
        }
        return {
            matched: true,
            value: nextValue,
            nextIndex: params.index + 2,
        };
    }
    if (token.startsWith(`${params.flag}=`)) {
        const value = token.slice(`${params.flag}=`.length).trim();
        if (!value) {
            return {
                matched: true,
                nextIndex: params.index + 1,
                error: `${params.flag} requires a value`,
            };
        }
        return {
            matched: true,
            value,
            nextIndex: params.index + 1,
        };
    }
    return { matched: false };
}
function resolveDefaultSpawnThreadMode(params) {
    if (resolveAcpCommandChannel(params) !== DISCORD_THREAD_BINDING_CHANNEL) {
        return "off";
    }
    const currentThreadId = resolveAcpCommandThreadId(params);
    return currentThreadId ? "here" : "auto";
}
export function parseSpawnInput(params, tokens) {
    let mode = "persistent";
    let thread = resolveDefaultSpawnThreadMode(params);
    let cwd;
    let label;
    let rawAgentId;
    for (let i = 0; i < tokens.length;) {
        const token = tokens[i] ?? "";
        const modeOption = readOptionValue({ tokens, index: i, flag: "--mode" });
        if (modeOption.matched) {
            if (modeOption.error) {
                return { ok: false, error: `${modeOption.error}. ${ACP_SPAWN_USAGE}` };
            }
            const raw = modeOption.value?.trim().toLowerCase();
            if (raw !== "persistent" && raw !== "oneshot") {
                return {
                    ok: false,
                    error: `Invalid --mode value "${modeOption.value}". Use persistent or oneshot.`,
                };
            }
            mode = raw;
            i = modeOption.nextIndex;
            continue;
        }
        const threadOption = readOptionValue({ tokens, index: i, flag: "--thread" });
        if (threadOption.matched) {
            if (threadOption.error) {
                return { ok: false, error: `${threadOption.error}. ${ACP_SPAWN_USAGE}` };
            }
            const raw = threadOption.value?.trim().toLowerCase();
            if (raw !== "auto" && raw !== "here" && raw !== "off") {
                return {
                    ok: false,
                    error: `Invalid --thread value "${threadOption.value}". Use auto, here, or off.`,
                };
            }
            thread = raw;
            i = threadOption.nextIndex;
            continue;
        }
        const cwdOption = readOptionValue({ tokens, index: i, flag: "--cwd" });
        if (cwdOption.matched) {
            if (cwdOption.error) {
                return { ok: false, error: `${cwdOption.error}. ${ACP_SPAWN_USAGE}` };
            }
            cwd = cwdOption.value?.trim();
            i = cwdOption.nextIndex;
            continue;
        }
        const labelOption = readOptionValue({ tokens, index: i, flag: "--label" });
        if (labelOption.matched) {
            if (labelOption.error) {
                return { ok: false, error: `${labelOption.error}. ${ACP_SPAWN_USAGE}` };
            }
            label = labelOption.value?.trim();
            i = labelOption.nextIndex;
            continue;
        }
        if (token.startsWith("--")) {
            return {
                ok: false,
                error: `Unknown option: ${token}. ${ACP_SPAWN_USAGE}`,
            };
        }
        if (!rawAgentId) {
            rawAgentId = token.trim();
            i += 1;
            continue;
        }
        return {
            ok: false,
            error: `Unexpected argument: ${token}. ${ACP_SPAWN_USAGE}`,
        };
    }
    const fallbackAgent = params.cfg.acp?.defaultAgent?.trim() || "";
    const selectedAgent = (rawAgentId?.trim() || fallbackAgent).trim();
    if (!selectedAgent) {
        return {
            ok: false,
            error: `ACP target agent is required. Pass an agent id or configure acp.defaultAgent. ${ACP_SPAWN_USAGE}`,
        };
    }
    const normalizedAgentId = normalizeAgentId(selectedAgent);
    return {
        ok: true,
        value: {
            agentId: normalizedAgentId,
            mode,
            thread,
            cwd,
            label: label || undefined,
        },
    };
}
export function parseSteerInput(tokens) {
    let sessionToken;
    const instructionTokens = [];
    for (let i = 0; i < tokens.length;) {
        const sessionOption = readOptionValue({
            tokens,
            index: i,
            flag: "--session",
        });
        if (sessionOption.matched) {
            if (sessionOption.error) {
                return {
                    ok: false,
                    error: `${sessionOption.error}. ${ACP_STEER_USAGE}`,
                };
            }
            sessionToken = sessionOption.value?.trim() || undefined;
            i = sessionOption.nextIndex;
            continue;
        }
        instructionTokens.push(tokens[i]);
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
export function parseSingleValueCommandInput(tokens, usage) {
    const value = tokens[0]?.trim() || "";
    if (!value) {
        return { ok: false, error: usage };
    }
    if (tokens.length > 2) {
        return { ok: false, error: usage };
    }
    const sessionToken = tokens[1]?.trim() || undefined;
    return {
        ok: true,
        value: {
            value,
            sessionToken,
        },
    };
}
export function parseSetCommandInput(tokens) {
    const key = tokens[0]?.trim() || "";
    const value = tokens[1]?.trim() || "";
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
    const sessionToken = tokens[2]?.trim() || undefined;
    return {
        ok: true,
        value: {
            key,
            value,
            sessionToken,
        },
    };
}
export function parseOptionalSingleTarget(tokens, usage) {
    if (tokens.length > 1) {
        return { ok: false, error: usage };
    }
    const token = tokens[0]?.trim() || "";
    return {
        ok: true,
        ...(token ? { sessionToken: token } : {}),
    };
}
export function resolveAcpHelpText() {
    return [
        "ACP commands:",
        "-----",
        "/acp spawn [agentId] [--mode persistent|oneshot] [--thread auto|here|off] [--cwd <path>] [--label <label>]",
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
        "- /focus and /unfocus also work with ACP session keys.",
        "- ACP dispatch of normal thread messages is controlled by acp.dispatch.enabled.",
    ].join("\n");
}
export function resolveConfiguredAcpBackendId(cfg) {
    return cfg.acp?.backend?.trim() || "acpx";
}
export function resolveAcpInstallCommandHint(cfg) {
    const configured = cfg.acp?.runtime?.installCommand?.trim();
    if (configured) {
        return configured;
    }
    const backendId = resolveConfiguredAcpBackendId(cfg).toLowerCase();
    if (backendId === "acpx") {
        const localPath = path.resolve(process.cwd(), "extensions/acpx");
        if (existsSync(localPath)) {
            return `openclaw plugins install ${localPath}`;
        }
        return "openclaw plugins install @openclaw/acpx";
    }
    return `Install and enable the plugin that provides ACP backend "${backendId}".`;
}
export function formatRuntimeOptionsText(options) {
    const extras = options.backendExtras
        ? Object.entries(options.backendExtras)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")
        : "";
    const parts = [
        options.runtimeMode ? `runtimeMode=${options.runtimeMode}` : null,
        options.model ? `model=${options.model}` : null,
        options.cwd ? `cwd=${options.cwd}` : null,
        options.permissionProfile ? `permissionProfile=${options.permissionProfile}` : null,
        typeof options.timeoutSeconds === "number" ? `timeoutSeconds=${options.timeoutSeconds}` : null,
        extras ? `extras={${extras}}` : null,
    ].filter(Boolean);
    if (parts.length === 0) {
        return "(none)";
    }
    return parts.join(", ");
}
export function formatAcpCapabilitiesText(controls) {
    if (controls.length === 0) {
        return "(none)";
    }
    return controls.toSorted().join(", ");
}
export function resolveCommandRequestId(params) {
    const value = params.ctx.MessageSidFull ??
        params.ctx.MessageSid ??
        params.ctx.MessageSidFirst ??
        params.ctx.MessageSidLast;
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }
    return randomUUID();
}
export function collectAcpErrorText(params) {
    return toAcpRuntimeErrorText({
        error: params.error,
        fallbackCode: params.fallbackCode,
        fallbackMessage: params.fallbackMessage,
    });
}
export async function withAcpCommandErrorBoundary(params) {
    try {
        const result = await params.run();
        return params.onSuccess(result);
    }
    catch (error) {
        return stopWithText(collectAcpErrorText({
            error,
            fallbackCode: params.fallbackCode,
            fallbackMessage: params.fallbackMessage,
        }));
    }
}
