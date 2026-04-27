import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { resolveGatewayInteractiveSurfaceAuth } from "../gateway/auth-surface-resolution.js";
import { buildGatewayConnectionDetails, ensureExplicitGatewayAuth, resolveExplicitGatewayAuth, } from "../gateway/call.js";
import { GatewayClient, GatewayClientRequestError } from "../gateway/client.js";
import { isLoopbackHost } from "../gateway/net.js";
import { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, } from "../gateway/protocol/client-info.js";
import { PROTOCOL_VERSION, } from "../gateway/protocol/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { VERSION } from "../version.js";
import { TUI_SETUP_AUTH_SOURCE_CONFIG, TUI_SETUP_AUTH_SOURCE_ENV } from "./setup-launch-env.js";
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;
function throwGatewayAuthResolutionError(reason) {
    throw new Error([
        reason,
        "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
        "or resolve the configured secret provider for this credential.",
    ].join("\n"));
}
function isRetryableStartupUnavailable(err, method) {
    if (!(err instanceof GatewayClientRequestError)) {
        return false;
    }
    if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
        return false;
    }
    const details = err.details;
    if (!details || typeof details !== "object") {
        return true;
    }
    const detailMethod = details.method;
    return typeof detailMethod !== "string" || detailMethod === method;
}
function resolveStartupRetryDelayMs(err) {
    const retryAfterMs = typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
    return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class GatewayChatClient {
    client;
    readyPromise;
    resolveReady;
    connection;
    hello;
    onEvent;
    onConnected;
    onDisconnected;
    onGap;
    constructor(connection) {
        this.connection = connection;
        this.readyPromise = new Promise((resolve) => {
            this.resolveReady = resolve;
        });
        this.client = new GatewayClient({
            url: connection.url,
            token: connection.token,
            password: connection.password,
            clientName: GATEWAY_CLIENT_NAMES.TUI,
            clientDisplayName: "openclaw-tui",
            clientVersion: VERSION,
            platform: process.platform,
            mode: GATEWAY_CLIENT_MODES.UI,
            deviceIdentity: connection.allowInsecureLocalOperatorUi ? null : undefined,
            caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
            instanceId: randomUUID(),
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            onHelloOk: (hello) => {
                this.hello = hello;
                this.resolveReady?.();
                this.onConnected?.();
            },
            onEvent: (evt) => {
                this.onEvent?.({
                    event: evt.event,
                    payload: evt.payload,
                    seq: evt.seq,
                });
            },
            onClose: (_code, reason) => {
                // Reset so waitForReady() blocks again until the next successful reconnect.
                this.readyPromise = new Promise((resolve) => {
                    this.resolveReady = resolve;
                });
                this.onDisconnected?.(reason);
            },
            onGap: (info) => {
                this.onGap?.(info);
            },
        });
    }
    static async connect(opts) {
        const connection = await resolveGatewayConnection(opts);
        return new GatewayChatClient(connection);
    }
    start() {
        this.client.start();
    }
    stop() {
        this.client.stop();
    }
    async waitForReady() {
        await this.readyPromise;
    }
    async sendChat(opts) {
        const runId = opts.runId ?? randomUUID();
        await this.client.request("chat.send", {
            sessionKey: opts.sessionKey,
            message: opts.message,
            thinking: opts.thinking,
            deliver: opts.deliver,
            timeoutMs: opts.timeoutMs,
            idempotencyKey: runId,
        });
        return { runId };
    }
    async abortChat(opts) {
        return await this.client.request("chat.abort", {
            sessionKey: opts.sessionKey,
            runId: opts.runId,
        });
    }
    async loadHistory(opts) {
        const startedAt = Date.now();
        for (;;) {
            try {
                return await this.client.request("chat.history", {
                    sessionKey: opts.sessionKey,
                    limit: opts.limit,
                });
            }
            catch (err) {
                const withinStartupRetryWindow = Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
                if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, "chat.history")) {
                    await sleep(resolveStartupRetryDelayMs(err));
                    continue;
                }
                throw err;
            }
        }
    }
    async listSessions(opts) {
        return await this.client.request("sessions.list", {
            limit: opts?.limit,
            activeMinutes: opts?.activeMinutes,
            includeGlobal: opts?.includeGlobal,
            includeUnknown: opts?.includeUnknown,
            includeDerivedTitles: opts?.includeDerivedTitles,
            includeLastMessage: opts?.includeLastMessage,
            agentId: opts?.agentId,
        });
    }
    async listAgents() {
        return await this.client.request("agents.list", {});
    }
    async patchSession(opts) {
        return await this.client.request("sessions.patch", opts);
    }
    async resetSession(key, reason) {
        return await this.client.request("sessions.reset", {
            key,
            ...(reason ? { reason } : {}),
        });
    }
    async getGatewayStatus() {
        return await this.client.request("status");
    }
    async listModels() {
        const res = await this.client.request("models.list");
        return Array.isArray(res?.models) ? res.models : [];
    }
}
export async function resolveGatewayConnection(opts) {
    const config = loadConfig();
    const env = process.env;
    const gatewayAuthMode = config.gateway?.auth?.mode;
    const isRemoteMode = config.gateway?.mode === "remote";
    const preferConfiguredAuth = env[TUI_SETUP_AUTH_SOURCE_ENV] === TUI_SETUP_AUTH_SOURCE_CONFIG;
    const urlOverride = typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined;
    const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
    ensureExplicitGatewayAuth({
        urlOverride,
        urlOverrideSource: "cli",
        explicitAuth,
        errorHint: "Fix: pass --token or --password when using --url.",
    });
    const url = buildGatewayConnectionDetails({
        config,
        ...(urlOverride ? { url: urlOverride } : {}),
    }).url;
    const allowInsecureLocalOperatorUi = (() => {
        if (config.gateway?.controlUi?.allowInsecureAuth !== true) {
            return false;
        }
        try {
            return isLoopbackHost(new URL(url).hostname);
        }
        catch {
            return false;
        }
    })();
    if (urlOverride) {
        return {
            url,
            token: explicitAuth.token,
            password: explicitAuth.password,
            allowInsecureLocalOperatorUi,
        };
    }
    if (isRemoteMode) {
        const resolved = await resolveGatewayInteractiveSurfaceAuth({
            config,
            env,
            explicitAuth,
            surface: "remote",
        });
        if (resolved.failureReason) {
            throwGatewayAuthResolutionError(resolved.failureReason);
        }
        return {
            url,
            token: resolved.token,
            password: resolved.password,
            allowInsecureLocalOperatorUi: false,
        };
    }
    if (gatewayAuthMode === "none" || gatewayAuthMode === "trusted-proxy") {
        const resolved = await resolveGatewayInteractiveSurfaceAuth({
            config,
            env,
            explicitAuth,
            surface: "local",
        });
        return {
            url,
            token: resolved.token,
            password: resolved.password,
            allowInsecureLocalOperatorUi,
        };
    }
    try {
        assertExplicitGatewayAuthModeWhenBothConfigured(config);
    }
    catch (err) {
        throwGatewayAuthResolutionError(formatErrorMessage(err));
    }
    const resolved = await resolveGatewayInteractiveSurfaceAuth({
        config,
        env,
        explicitAuth,
        suppressEnvAuthFallback: preferConfiguredAuth,
        surface: "local",
    });
    if (resolved.failureReason) {
        throwGatewayAuthResolutionError(resolved.failureReason);
    }
    return {
        url,
        token: resolved.token,
        password: resolved.password,
        allowInsecureLocalOperatorUi,
    };
}
