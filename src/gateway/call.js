import { randomUUID } from "node:crypto";
import { loadConfig, resolveConfigPath, resolveGatewayPort, resolveStateDir, } from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { CLI_DEFAULT_OPERATOR_SCOPES, resolveLeastPrivilegeOperatorScopesForMethod, } from "./method-scopes.js";
import { isSecureWebSocketUrl } from "./net.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
export function resolveExplicitGatewayAuth(opts) {
    const token = typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
    const password = typeof opts?.password === "string" && opts.password.trim().length > 0
        ? opts.password.trim()
        : undefined;
    return { token, password };
}
export function ensureExplicitGatewayAuth(params) {
    if (!params.urlOverride) {
        return;
    }
    if (params.auth.token || params.auth.password) {
        return;
    }
    const message = [
        "gateway url override requires explicit credentials",
        params.errorHint,
        params.configPath ? `Config: ${params.configPath}` : undefined,
    ]
        .filter(Boolean)
        .join("\n");
    throw new Error(message);
}
export function buildGatewayConnectionDetails(options = {}) {
    const config = options.config ?? loadConfig();
    const configPath = options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
    const isRemoteMode = config.gateway?.mode === "remote";
    const remote = isRemoteMode ? config.gateway?.remote : undefined;
    const tlsEnabled = config.gateway?.tls?.enabled === true;
    const localPort = resolveGatewayPort(config);
    const bindMode = config.gateway?.bind ?? "loopback";
    const scheme = tlsEnabled ? "wss" : "ws";
    // Self-connections should always target loopback; bind mode only controls listener exposure.
    const localUrl = `${scheme}://127.0.0.1:${localPort}`;
    const urlOverride = typeof options.url === "string" && options.url.trim().length > 0
        ? options.url.trim()
        : undefined;
    const remoteUrl = typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
    const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
    const url = urlOverride || remoteUrl || localUrl;
    const urlSource = urlOverride
        ? "cli --url"
        : remoteUrl
            ? "config gateway.remote.url"
            : remoteMisconfigured
                ? "missing gateway.remote.url (fallback local)"
                : "local loopback";
    const remoteFallbackNote = remoteMisconfigured
        ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
        : undefined;
    const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
    const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
    // Security check: block ALL insecure ws:// to non-loopback addresses (CWE-319, CVSS 9.8)
    // This applies to the FINAL resolved URL, regardless of source (config, CLI override, etc).
    // Both credentials and chat/conversation data must not be transmitted over plaintext to remote hosts.
    if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
        throw new Error([
            `SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
            "Both credentials and chat data would be exposed to network interception.",
            `Source: ${urlSource}`,
            `Config: ${configPath}`,
            "Fix: Use wss:// for remote gateway URLs.",
            "Safe remote access defaults:",
            "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
            "- or use Tailscale Serve/Funnel for HTTPS remote access",
            allowPrivateWs
                ? undefined
                : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
            "Doctor: openclaw doctor --fix",
            "Docs: https://docs.openclaw.ai/gateway/remote",
        ].join("\n"));
    }
    const message = [
        `Gateway target: ${url}`,
        `Source: ${urlSource}`,
        `Config: ${configPath}`,
        bindDetail,
        remoteFallbackNote,
    ]
        .filter(Boolean)
        .join("\n");
    return {
        url,
        urlSource,
        bindDetail,
        remoteFallbackNote,
        message,
    };
}
function trimToUndefined(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function resolveGatewayCallTimeout(timeoutValue) {
    const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : 10000;
    const safeTimerTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2147483647));
    return { timeoutMs, safeTimerTimeoutMs };
}
function resolveGatewayCallContext(opts) {
    const config = opts.config ?? loadConfig();
    const configPath = opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
    const isRemoteMode = config.gateway?.mode === "remote";
    const remote = isRemoteMode
        ? config.gateway?.remote
        : undefined;
    const urlOverride = trimToUndefined(opts.url);
    const remoteUrl = trimToUndefined(remote?.url);
    const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
    return { config, configPath, isRemoteMode, remote, urlOverride, remoteUrl, explicitAuth };
}
function ensureRemoteModeUrlConfigured(context) {
    if (!context.isRemoteMode || context.urlOverride || context.remoteUrl) {
        return;
    }
    throw new Error([
        "gateway remote mode misconfigured: gateway.remote.url missing",
        `Config: ${context.configPath}`,
        "Fix: set gateway.remote.url, or set gateway.mode=local.",
    ].join("\n"));
}
function resolveGatewayCredentials(context) {
    return resolveGatewayCredentialsFromConfig({
        cfg: context.config,
        env: process.env,
        explicitAuth: context.explicitAuth,
        urlOverride: context.urlOverride,
        remotePasswordPrecedence: "env-first",
    });
}
async function resolveGatewayTlsFingerprint(params) {
    const { opts, context, url } = params;
    const useLocalTls = context.config.gateway?.tls?.enabled === true &&
        !context.urlOverride &&
        !context.remoteUrl &&
        url.startsWith("wss://");
    const tlsRuntime = useLocalTls
        ? await loadGatewayTlsRuntime(context.config.gateway?.tls)
        : undefined;
    const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
    const remoteTlsFingerprint = context.isRemoteMode && !context.urlOverride && context.remoteUrl
        ? trimToUndefined(context.remote?.tlsFingerprint)
        : undefined;
    return (overrideTlsFingerprint ||
        remoteTlsFingerprint ||
        (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined));
}
function formatGatewayCloseError(code, reason, connectionDetails) {
    const reasonText = reason?.trim() || "no close reason";
    const hint = code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
    const suffix = hint ? ` ${hint}` : "";
    return `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
}
function formatGatewayTimeoutError(timeoutMs, connectionDetails) {
    return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}
async function executeGatewayRequestWithScopes(params) {
    const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs } = params;
    return await new Promise((resolve, reject) => {
        let settled = false;
        let ignoreClose = false;
        const stop = (err, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (err) {
                reject(err);
            }
            else {
                resolve(value);
            }
        };
        const client = new GatewayClient({
            url,
            token,
            password,
            tlsFingerprint,
            instanceId: opts.instanceId ?? randomUUID(),
            clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
            clientDisplayName: opts.clientDisplayName,
            clientVersion: opts.clientVersion ?? "dev",
            platform: opts.platform,
            mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
            role: "operator",
            scopes,
            deviceIdentity: loadOrCreateDeviceIdentity(),
            minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
            maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
            onHelloOk: async () => {
                try {
                    const result = await client.request(opts.method, opts.params, {
                        expectFinal: opts.expectFinal,
                    });
                    ignoreClose = true;
                    stop(undefined, result);
                    client.stop();
                }
                catch (err) {
                    ignoreClose = true;
                    client.stop();
                    stop(err);
                }
            },
            onClose: (code, reason) => {
                if (settled || ignoreClose) {
                    return;
                }
                ignoreClose = true;
                client.stop();
                stop(new Error(formatGatewayCloseError(code, reason, params.connectionDetails)));
            },
        });
        const timer = setTimeout(() => {
            ignoreClose = true;
            client.stop();
            stop(new Error(formatGatewayTimeoutError(timeoutMs, params.connectionDetails)));
        }, safeTimerTimeoutMs);
        client.start();
    });
}
async function callGatewayWithScopes(opts, scopes) {
    const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
    const context = resolveGatewayCallContext(opts);
    ensureExplicitGatewayAuth({
        urlOverride: context.urlOverride,
        auth: context.explicitAuth,
        errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
        configPath: context.configPath,
    });
    ensureRemoteModeUrlConfigured(context);
    const connectionDetails = buildGatewayConnectionDetails({
        config: context.config,
        url: context.urlOverride,
        ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
    const url = connectionDetails.url;
    const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
    const { token, password } = resolveGatewayCredentials(context);
    return await executeGatewayRequestWithScopes({
        opts,
        scopes,
        url,
        token,
        password,
        tlsFingerprint,
        timeoutMs,
        safeTimerTimeoutMs,
        connectionDetails,
    });
}
export async function callGatewayScoped(opts) {
    return await callGatewayWithScopes(opts, opts.scopes);
}
export async function callGatewayCli(opts) {
    const scopes = Array.isArray(opts.scopes) ? opts.scopes : CLI_DEFAULT_OPERATOR_SCOPES;
    return await callGatewayWithScopes(opts, scopes);
}
export async function callGatewayLeastPrivilege(opts) {
    const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method);
    return await callGatewayWithScopes(opts, scopes);
}
export async function callGateway(opts) {
    if (Array.isArray(opts.scopes)) {
        return await callGatewayWithScopes(opts, opts.scopes);
    }
    const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
    const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
    if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) {
        return await callGatewayCli(opts);
    }
    return await callGatewayLeastPrivilege({
        ...opts,
        mode: callerMode,
        clientName: callerName,
    });
}
export function randomIdempotencyKey() {
    return randomUUID();
}
