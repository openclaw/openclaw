import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/io.js";
import { resolveConfigPath as resolveConfigPathFromPaths, resolveGatewayPort as resolveGatewayPortFromPaths, resolveStateDir as resolveStateDirFromPaths, } from "../config/paths.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, } from "../utils/message-channel.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { VERSION } from "../version.js";
import { GatewayClient } from "./client.js";
import { buildGatewayConnectionDetailsWithResolvers, } from "./connection-details.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { trimToUndefined, } from "./credentials.js";
import { canSkipGatewayConfigLoad } from "./explicit-connection-policy.js";
import { CLI_DEFAULT_OPERATOR_SCOPES, resolveLeastPrivilegeOperatorScopesForMethod, } from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
const defaultCreateGatewayClient = (opts) => new GatewayClient(opts);
const defaultGatewayCallDeps = {
    createGatewayClient: defaultCreateGatewayClient,
    loadConfig,
    loadOrCreateDeviceIdentity,
    resolveGatewayPort: resolveGatewayPortFromPaths,
    resolveConfigPath: resolveConfigPathFromPaths,
    resolveStateDir: resolveStateDirFromPaths,
    loadGatewayTlsRuntime,
};
const gatewayCallDeps = {
    ...defaultGatewayCallDeps,
};
async function stopGatewayClient(client) {
    try {
        await client.stopAndWait({ timeoutMs: 1_000 });
    }
    catch {
        client.stop();
    }
}
function resolveGatewayClientDisplayName(opts) {
    if (opts.clientDisplayName) {
        return opts.clientDisplayName;
    }
    const clientName = opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
    const mode = opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
    if (mode !== GATEWAY_CLIENT_MODES.BACKEND && clientName !== GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT) {
        return undefined;
    }
    const method = opts.method.trim();
    return method ? `gateway:${method}` : "gateway:request";
}
function loadGatewayConfig() {
    const loadConfigFn = typeof gatewayCallDeps.loadConfig === "function"
        ? gatewayCallDeps.loadConfig
        : typeof defaultGatewayCallDeps.loadConfig === "function"
            ? defaultGatewayCallDeps.loadConfig
            : loadConfig;
    return loadConfigFn();
}
function resolveGatewayStateDir(env) {
    const resolveStateDirFn = typeof gatewayCallDeps.resolveStateDir === "function"
        ? gatewayCallDeps.resolveStateDir
        : resolveStateDirFromPaths;
    return resolveStateDirFn(env);
}
function resolveGatewayConfigPath(env) {
    const resolveConfigPathFn = typeof gatewayCallDeps.resolveConfigPath === "function"
        ? gatewayCallDeps.resolveConfigPath
        : resolveConfigPathFromPaths;
    return resolveConfigPathFn(env, resolveGatewayStateDir(env));
}
function resolveGatewayPortValue(config, env) {
    const resolveGatewayPortFn = typeof gatewayCallDeps.resolveGatewayPort === "function"
        ? gatewayCallDeps.resolveGatewayPort
        : resolveGatewayPortFromPaths;
    return resolveGatewayPortFn(config, env);
}
export function buildGatewayConnectionDetails(options = {}) {
    return buildGatewayConnectionDetailsWithResolvers(options, {
        loadConfig: () => loadGatewayConfig(),
        resolveConfigPath: (env) => resolveGatewayConfigPath(env),
        resolveGatewayPort: (config, env) => resolveGatewayPortValue(config, env),
    });
}
export const __testing = {
    setDepsForTests(deps) {
        gatewayCallDeps.createGatewayClient =
            deps?.createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
        gatewayCallDeps.loadConfig = deps?.loadConfig ?? defaultGatewayCallDeps.loadConfig;
        gatewayCallDeps.loadOrCreateDeviceIdentity =
            deps?.loadOrCreateDeviceIdentity ?? defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
        gatewayCallDeps.resolveGatewayPort =
            deps?.resolveGatewayPort ?? defaultGatewayCallDeps.resolveGatewayPort;
        gatewayCallDeps.resolveConfigPath =
            deps?.resolveConfigPath ?? defaultGatewayCallDeps.resolveConfigPath;
        gatewayCallDeps.resolveStateDir =
            deps?.resolveStateDir ?? defaultGatewayCallDeps.resolveStateDir;
        gatewayCallDeps.loadGatewayTlsRuntime =
            deps?.loadGatewayTlsRuntime ?? defaultGatewayCallDeps.loadGatewayTlsRuntime;
    },
    setCreateGatewayClientForTests(createGatewayClient) {
        gatewayCallDeps.createGatewayClient =
            createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
    },
    resetDepsForTests() {
        gatewayCallDeps.createGatewayClient = defaultGatewayCallDeps.createGatewayClient;
        gatewayCallDeps.loadConfig = defaultGatewayCallDeps.loadConfig;
        gatewayCallDeps.loadOrCreateDeviceIdentity = defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
        gatewayCallDeps.resolveGatewayPort = defaultGatewayCallDeps.resolveGatewayPort;
        gatewayCallDeps.resolveConfigPath = defaultGatewayCallDeps.resolveConfigPath;
        gatewayCallDeps.resolveStateDir = defaultGatewayCallDeps.resolveStateDir;
        gatewayCallDeps.loadGatewayTlsRuntime = defaultGatewayCallDeps.loadGatewayTlsRuntime;
    },
};
function resolveDeviceIdentityForGatewayCall() {
    // Shared-auth local calls should still stay device-bound so operator scopes
    // remain available for detail RPCs such as status / system-presence /
    // last-heartbeat.
    try {
        return gatewayCallDeps.loadOrCreateDeviceIdentity();
    }
    catch {
        // Read-only or restricted environments should still be able to call the
        // gateway with token/password auth without crashing before the RPC.
        return null;
    }
}
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
    // URL overrides are untrusted redirects and can move WebSocket traffic off the intended host.
    // Never allow an override to silently reuse implicit credentials or device token fallback.
    const explicitToken = params.explicitAuth?.token;
    const explicitPassword = params.explicitAuth?.password;
    if (params.urlOverrideSource === "cli" && (explicitToken || explicitPassword)) {
        return;
    }
    const hasResolvedAuth = params.resolvedAuth?.token ||
        params.resolvedAuth?.password ||
        explicitToken ||
        explicitPassword;
    // Env overrides are supported for deployment ergonomics, but only when explicit auth is available.
    // This avoids implicit device-token fallback against attacker-controlled WSS endpoints.
    if (params.urlOverrideSource === "env" && hasResolvedAuth) {
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
function resolveGatewayCallTimeout(timeoutValue) {
    const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : 10_000;
    const safeTimerTimeoutMs = resolveSafeTimeoutDelayMs(timeoutMs);
    return { timeoutMs, safeTimerTimeoutMs };
}
function resolveGatewayCallContext(opts) {
    const cliUrlOverride = trimToUndefined(opts.url);
    const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
    const envUrlOverride = cliUrlOverride
        ? undefined
        : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
    const urlOverride = cliUrlOverride ?? envUrlOverride;
    const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined;
    const canSkipConfigLoad = canSkipGatewayConfigLoad({
        config: opts.config,
        urlOverride,
        explicitAuth,
    });
    const config = opts.config ?? (canSkipConfigLoad ? {} : loadGatewayConfig());
    const configPath = opts.configPath ?? resolveGatewayConfigPath(process.env);
    const isRemoteMode = config.gateway?.mode === "remote";
    const remote = isRemoteMode
        ? config.gateway?.remote
        : undefined;
    const remoteUrl = trimToUndefined(remote?.url);
    return {
        config,
        configPath,
        isRemoteMode,
        remote,
        urlOverride,
        urlOverrideSource,
        remoteUrl,
        explicitAuth,
    };
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
async function resolveGatewayCredentials(context) {
    return resolveGatewayCredentialsWithEnv(context, process.env);
}
async function resolveGatewayCredentialsWithEnv(context, env) {
    if (context.explicitAuth.token || context.explicitAuth.password) {
        return {
            token: context.explicitAuth.token,
            password: context.explicitAuth.password,
        };
    }
    return resolveGatewayCredentialsWithSecretInputs({
        config: context.config,
        explicitAuth: context.explicitAuth,
        urlOverride: context.urlOverride,
        urlOverrideSource: context.urlOverrideSource,
        env,
        modeOverride: context.modeOverride,
        localTokenPrecedence: context.localTokenPrecedence,
        localPasswordPrecedence: context.localPasswordPrecedence,
        remoteTokenPrecedence: context.remoteTokenPrecedence,
        remotePasswordPrecedence: context.remotePasswordPrecedence,
        remoteTokenFallback: context.remoteTokenFallback,
        remotePasswordFallback: context.remotePasswordFallback,
    });
}
export { resolveGatewayCredentialsWithSecretInputs };
async function resolveGatewayTlsFingerprint(params) {
    const { opts, context, url } = params;
    const useLocalTls = context.config.gateway?.tls?.enabled === true &&
        !context.urlOverrideSource &&
        !context.remoteUrl &&
        url.startsWith("wss://");
    const tlsRuntime = useLocalTls
        ? await gatewayCallDeps.loadGatewayTlsRuntime(context.config.gateway?.tls)
        : undefined;
    const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
    const remoteTlsFingerprint = 
    // Env overrides may still inherit configured remote TLS pinning for private cert deployments.
    // CLI overrides remain explicit-only and intentionally skip config remote TLS to avoid
    // accidentally pinning against caller-supplied target URLs.
    context.isRemoteMode && context.urlOverrideSource !== "cli"
        ? trimToUndefined(context.remote?.tlsFingerprint)
        : undefined;
    return (overrideTlsFingerprint ||
        remoteTlsFingerprint ||
        (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined));
}
function formatGatewayCloseError(code, reason, connectionDetails) {
    const reasonText = normalizeOptionalString(reason) || "no close reason";
    const hint = code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
    const suffix = hint ? ` ${hint}` : "";
    let message = `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
    // Add troubleshooting hints for common issues
    if (code === 1006) {
        message +=
            "\n\nPossible causes:" +
                "\n- Gateway not yet ready to accept connections (retry after a moment)" +
                "\n- TLS mismatch (connecting with ws:// to a wss:// gateway, or vice versa)" +
                "\n- Gateway crashed or was terminated unexpectedly" +
                "\nRun `openclaw doctor` for diagnostics.";
    }
    return message;
}
function formatGatewayTimeoutError(timeoutMs, connectionDetails) {
    return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}
function ensureGatewaySupportsRequiredMethods(params) {
    const requiredMethods = Array.isArray(params.requiredMethods)
        ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        : [];
    if (requiredMethods.length === 0) {
        return;
    }
    const supportedMethods = new Set((Array.isArray(params.methods) ? params.methods : [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0));
    for (const method of requiredMethods) {
        if (supportedMethods.has(method)) {
            continue;
        }
        throw new Error([
            `active gateway does not support required method "${method}" for "${params.attemptedMethod}".`,
            "Update the gateway or run without SecretRefs.",
        ].join(" "));
    }
}
async function executeGatewayRequestWithScopes(params) {
    const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs } = params;
    // Yield to the event loop before starting the WebSocket connection.
    // On Windows with large dist bundles, heavy synchronous module loading
    // can starve the event loop, preventing timely processing of the
    // connect.challenge frame and causing handshake timeouts (#48736).
    await new Promise((r) => setImmediate(r));
    return await new Promise((resolve, reject) => {
        let settled = false;
        let ignoreClose = false;
        const stop = (err, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            void stopGatewayClient(client).finally(() => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(value);
                }
            });
        };
        const client = gatewayCallDeps.createGatewayClient({
            url,
            token,
            password,
            tlsFingerprint,
            instanceId: opts.instanceId ?? randomUUID(),
            clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
            clientDisplayName: resolveGatewayClientDisplayName(opts),
            clientVersion: opts.clientVersion ?? VERSION,
            platform: opts.platform,
            mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
            role: "operator",
            scopes,
            deviceIdentity: opts.deviceIdentity === undefined
                ? resolveDeviceIdentityForGatewayCall()
                : opts.deviceIdentity,
            minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
            maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
            onHelloOk: async (hello) => {
                try {
                    ensureGatewaySupportsRequiredMethods({
                        requiredMethods: opts.requiredMethods,
                        methods: hello.features?.methods,
                        attemptedMethod: opts.method,
                    });
                    const result = await client.request(opts.method, opts.params, {
                        expectFinal: opts.expectFinal,
                        timeoutMs: opts.timeoutMs,
                    });
                    ignoreClose = true;
                    stop(undefined, result);
                }
                catch (err) {
                    ignoreClose = true;
                    stop(err);
                }
            },
            onClose: (code, reason) => {
                if (settled || ignoreClose) {
                    return;
                }
                ignoreClose = true;
                stop(new Error(formatGatewayCloseError(code, reason, params.connectionDetails)));
            },
        });
        const timer = setTimeout(() => {
            ignoreClose = true;
            stop(new Error(formatGatewayTimeoutError(timeoutMs, params.connectionDetails)));
        }, safeTimerTimeoutMs);
        client.start();
    });
}
async function callGatewayWithScopes(opts, scopes) {
    const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
    const context = resolveGatewayCallContext(opts);
    const resolvedCredentials = await resolveGatewayCredentials(context);
    ensureExplicitGatewayAuth({
        urlOverride: context.urlOverride,
        urlOverrideSource: context.urlOverrideSource,
        explicitAuth: context.explicitAuth,
        resolvedAuth: resolvedCredentials,
        errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
        configPath: context.configPath,
    });
    ensureRemoteModeUrlConfigured(context);
    const connectionDetails = buildGatewayConnectionDetails({
        config: context.config,
        url: context.urlOverride,
        urlSource: context.urlOverrideSource,
        ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
    const url = connectionDetails.url;
    const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
    const { token, password } = resolvedCredentials;
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
