import { isDeepStrictEqual } from "node:util";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV2,
  type GatewayControlUiIngressPresentationOptionsV1,
  type GatewayIngressPrincipalOptionsV1,
  type GatewayIngressPrincipalBindingV1,
  type GatewayControlUiIngressRequestV1,
  type GatewayControlUiIngressV2,
} from "../plugins/gateway-ingress.types.js";
import { validateRemoteControlUiFrameAncestors } from "./control-ui-csp.js";
import { filterRemoteControlUiPluginReadCookies } from "./control-ui-plugin-auth-cookie.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { isOperatorScope } from "./operator-scopes.js";
import { resolveRemoteControlUiHttpRoute } from "./remote-control-ui-http-routing.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createRemoteControlUiTransport } from "./remote-control-ui-transport.js";
import { prepareRemoteIngressPrincipal } from "./remote-ingress-principal.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { RemoteControlUiIngressContext } from "./server/client-identity-types.js";

const MAX_HTTP_PER_HANDLE = 16;
const requestHeaders = new Set([
  "accept",
  "accept-language",
  "accept-encoding",
  "authorization",
  "content-type",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "user-agent",
  "service-worker",
]);
const responseHeaders = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-disposition",
  "etag",
  "last-modified",
  "cache-control",
  "expires",
  "vary",
  "accept-ranges",
  "content-range",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "retry-after",
  "location",
]);

function invalid(message: string): never {
  throw new GatewayControlUiIngressError("invalid-options", message);
}

function validateOrigin(value: string, name: string): string {
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.hostname.includes("*") ||
    url.username ||
    url.password
  ) {
    invalid(
      `${name} must be an exact HTTPS origin without a path, credentials, query, or fragment.`,
    );
  }
  return value;
}

function validatePath(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    containsAsciiControlCharacter(value) ||
    /[\\ #]/.test(value)
  ) {
    invalid("pathAndQuery must be a bounded origin-relative path and query.");
  }
  const url = URL.parse(value, "https://ingress.invalid");
  if (!url || `${url.pathname}${url.search}` !== value || /%(?:5c|00|0a|0d)/i.test(url.pathname)) {
    invalid("pathAndQuery contains an ambiguous or encoded path separator.");
  }
}

function prepareRequestHeaders(input: GatewayControlUiIngressRequestV1["headers"], origin: string) {
  const headers: [string, string][] = [];
  for (const [rawName, value] of input) {
    const name = rawName.toLowerCase();
    if (name === "content-encoding" && value.toLowerCase() !== "identity") {
      invalid("Compressed remote Control UI request bodies are unsupported; send decoded bytes.");
    }
    if (requestHeaders.has(name)) {
      headers.push([name, value]);
    }
    if (name === "cookie") {
      const cookies = filterRemoteControlUiPluginReadCookies(value);
      if (cookies) {
        headers.push([name, cookies]);
      }
    }
  }
  // Host is presentation only. Provenance and exact Origin admission remain core-owned.
  headers.push(["host", new URL(origin).host]);
  return headers;
}

function validatePresentation(options: GatewayControlUiIngressPresentationOptionsV1) {
  const publicOrigin = validateOrigin(options.publicOrigin, "publicOrigin");
  const sandboxOrigin = validateOrigin(options.sandboxOrigin, "sandboxOrigin");
  if (publicOrigin === sandboxOrigin) {
    invalid("sandboxOrigin must be distinct from publicOrigin.");
  }
  try {
    return {
      publicOrigin,
      sandboxOrigin,
      frameAncestors: validateRemoteControlUiFrameAncestors(options.frameAncestors),
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid frame ancestors.");
  }
}

function validatePrincipalOptions(options: GatewayIngressPrincipalOptionsV1) {
  if (
    !options.principal ||
    (options.principal.kind !== "owner" && options.principal.kind !== "person") ||
    (options.principal.kind === "person" &&
      (typeof options.principal.profileId !== "string" || !options.principal.profileId.trim()))
  ) {
    invalid("principal must explicitly select owner or an existing verified person profile.");
  }
  if (options.operatorScopeCeiling.some((scope) => !isOperatorScope(scope))) {
    invalid("operatorScopeCeiling must contain only supported operator scopes.");
  }
  return Object.freeze([...new Set(options.operatorScopeCeiling)]);
}

/** Only service admission supplies this factory; plugins never choose a listener or socket target. */
export function createGatewayControlUiIngressFactory(params: {
  pluginId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  host: GatewayControlUiIngressHost;
}): GatewayControlUiIngressFactoryV2 {
  const { host, pluginId } = params;
  async function bindPrincipal(
    options: GatewayIngressPrincipalOptionsV1,
  ): Promise<GatewayIngressPrincipalBindingV1> {
    const operatorScopeCeiling = validatePrincipalOptions(options);
    const principal = Object.freeze({ ...options.principal });
    const grantSignal = AbortSignal.any([params.signal, host.signal, options.signal]);
    const grantAssertion = options.assertCurrent;
    const assertGrant = () => {
      grantSignal.throwIfAborted();
      params.assertCurrent();
      grantAssertion();
    };
    assertGrant();
    const authority = await prepareRemoteIngressPrincipal({
      principal,
      operatorScopeCeiling,
      getRuntimeConfig: () => host.getRuntimeConfig(),
      getResolvedAuth: () => host.getResolvedAuth(),
      signal: grantSignal,
      assertCurrent: assertGrant,
    });
    const principalSignal = authority.signal;
    const resolvePrincipal = () => authority.resolve();
    const assertPrincipalCurrent = authority.assertCurrent;
    const closeBinding = async () => {
      authority.close();
    };
    const requestPrincipal = async <T>(
      method: string,
      requestParams: Record<string, unknown>,
      requestOptions?: { signal?: AbortSignal },
      ingressContext?: RemoteControlUiIngressContext,
    ): Promise<T> => {
      const principalSnapshot = resolvePrincipal();
      const context = host.resolveGatewayContext?.();
      if (!context) {
        throw new GatewayControlUiIngressError(
          "unavailable",
          "Gateway request dispatch is unavailable.",
        );
      }
      const requestSignal = requestOptions?.signal
        ? AbortSignal.any([principalSignal, requestOptions.signal])
        : principalSignal;
      const assertRequestCurrent = () => {
        requestSignal.throwIfAborted();
        principalSnapshot.assertCurrent();
        if (host.resolveGatewayContext?.() !== context) {
          throw new GatewayControlUiIngressError("closed", "Gateway request owner was replaced.");
        }
      };
      const hasCurrentClientAuthority = () => {
        try {
          assertRequestCurrent();
          return true;
        } catch {
          return false;
        }
      };
      assertRequestCurrent();
      const internal: NonNullable<GatewayClient["internal"]> = {
        authenticatedOperator: true,
        remoteIngressPrincipal: principalSnapshot,
        operatorDeviceTokenIdentity: null,
        operatorRoleActor: principalSnapshot.operatorRoleActor,
        operatorAccessAuthority: principalSnapshot.operatorAccessAuthority,
        pluginRuntimeOwnerId: pluginId,
      };
      const client: GatewayClient = {
        connectionSignal: requestSignal,
        remoteControlUiIngress: ingressContext,
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "gateway-client", version: "1", platform: "plugin", mode: "backend" },
          role: "operator",
          scopes: [...principalSnapshot.scopes],
        },
        authenticatedUserProfile: principalSnapshot.authenticatedUserProfile,
        preparedSessionProfile: principalSnapshot.preparedSessionProfile,
        internal,
      };
      const captured = await captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority,
        invocationAuthority: { assertCurrent: assertRequestCurrent, signal: requestSignal },
      });
      try {
        assertRequestCurrent();
        if (captured) {
          internal.operatorRunAuthority = captured.authority;
        }
        const result = await dispatchGatewayRequestInProcess<T>(method, requestParams, {
          client,
          context,
          signal: requestSignal,
          hasCurrentClientAuthority,
          methodRegistry: context.getGatewayMethodRegistry?.(),
          requestIdPrefix: "remote-ingress",
          assertPreparationCurrent: assertRequestCurrent,
          sessionMutationCommitGuard: assertRequestCurrent,
          assertCreatedInputSourceCurrent: assertRequestCurrent,
        });
        assertRequestCurrent();
        return result;
      } finally {
        captured?.release();
      }
    };
    async function openControlUi(
      presentationOptions: GatewayControlUiIngressPresentationOptionsV1,
    ): Promise<GatewayControlUiIngressV2> {
      const presentation = {
        ...validatePresentation(presentationOptions),
        operatorScopeCeiling,
      };
      const readOriginPolicy = () => {
        const gateway = host.getRuntimeConfig().gateway;
        return {
          enabled: gateway?.controlUi?.enabled !== false,
          publicOrigin: gateway?.publicOrigin,
          allowedOrigins: gateway?.controlUi?.allowedOrigins?.slice(),
          hostFallback: gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
        };
      };
      const originPolicy = readOriginPolicy();
      const handleLifetime = new AbortController();
      const handleSignal = AbortSignal.any([principalSignal, handleLifetime.signal]);
      const assertHandleCurrent = () => {
        if (handleSignal.aborted) {
          throw new GatewayControlUiIngressError("closed", "Remote Control UI ingress is closed.");
        }
        try {
          assertPrincipalCurrent();
        } catch (error) {
          handleLifetime.abort(error);
          throw error;
        }
        const current = readOriginPolicy();
        if (!current.enabled || !isDeepStrictEqual(current, originPolicy)) {
          const error = new GatewayControlUiIngressError(
            "closed",
            "Control UI origin policy changed; open a new ingress handle under the current policy.",
          );
          handleLifetime.abort(error);
          throw error;
        }
      };
      assertHandleCurrent();
      const context: RemoteControlUiIngressContext = Object.freeze({
        ...presentation,
        pluginId,
        audienceId: options.audienceId,
        principal,
        resolvePrincipal,
        signal: handleSignal,
        assertCurrent: assertHandleCurrent,
      });
      const transport = createRemoteControlUiTransport({ context, host });
      let http = 0;
      const sockets = { main: 0, auxiliary: 0 };
      const closeHandle = () => {
        handleLifetime.abort();
        return transport.close();
      };
      const handle: GatewayControlUiIngressV2 = {
        async requestGateway(method, requestParams, requestOptions) {
          assertHandleCurrent();
          const requestSignal = requestOptions?.signal
            ? AbortSignal.any([handleSignal, requestOptions.signal])
            : handleSignal;
          return requestPrincipal(method, requestParams, { signal: requestSignal }, context);
        },
        presentation: Object.freeze({
          basePath: host.controlUiBasePath,
          publicOrigin: presentation.publicOrigin,
          sandboxOrigin: presentation.sandboxOrigin,
          operatorScopeCeiling: presentation.operatorScopeCeiling,
        }),
        async request(input) {
          assertHandleCurrent();
          validatePath(input.pathAndQuery);
          if (input.surface !== "control-ui" && input.surface !== "sandbox") {
            invalid("Unknown remote Control UI surface.");
          }
          if (
            !["GET", "HEAD", "POST"].includes(input.method) ||
            (input.body && input.method !== "POST")
          ) {
            invalid("Remote Control UI supports GET/HEAD and owner-authorized POST bodies only.");
          }
          const origin =
            input.surface === "sandbox" ? presentation.sandboxOrigin : presentation.publicOrigin;
          const headers = prepareRequestHeaders(input.headers, origin);
          if (http >= MAX_HTTP_PER_HANDLE) {
            throw new GatewayControlUiIngressError(
              "limit-exceeded",
              "Remote Control UI HTTP concurrency quota exceeded.",
            );
          }
          http += 1;
          const release = () => {
            http -= 1;
          };
          let result: Awaited<ReturnType<typeof transport.request>> | undefined;
          try {
            result = await transport.request({ ...input, headers });
            void result.closed.then(release, release);
            assertHandleCurrent();
            const safeHeaders = new Headers();
            for (const [name, value] of result.response.headers) {
              if (responseHeaders.has(name)) {
                safeHeaders.append(name, value);
              }
            }
            const location = safeHeaders.get("location");
            if (location) {
              const target = URL.parse(location, `${origin}${input.pathAndQuery}`);
              if (
                !target ||
                target.origin !== origin ||
                target.username ||
                target.password ||
                target.hash
              ) {
                throw new GatewayControlUiIngressError(
                  "forbidden",
                  "Remote Control UI refused a redirect outside this origin.",
                );
              }
              validatePath(`${target.pathname}${target.search}`);
              if (
                input.surface === "sandbox" ||
                !resolveRemoteControlUiHttpRoute(
                  {
                    method: "GET",
                    url: `${target.pathname}${target.search}`,
                    headers: { accept: "text/html" },
                  },
                  host.controlUiBasePath,
                  presentation.operatorScopeCeiling,
                )
              ) {
                throw new GatewayControlUiIngressError(
                  "forbidden",
                  "Remote Control UI refused a redirect outside its route surface.",
                );
              }
            }
            return {
              response: new Response(result.response.body, {
                status: result.response.status,
                headers: safeHeaders,
              }),
              pluginReadCookies: result.pluginReadCookies,
            };
          } catch (error) {
            if (result) {
              void result.response.body?.cancel(error).catch(() => undefined);
            } else {
              release();
            }
            throw error;
          }
        },
        async openWebSocket(input) {
          assertHandleCurrent();
          validatePath(input.pathAndQuery);
          if (input.origin !== presentation.publicOrigin) {
            throw new GatewayControlUiIngressError(
              "forbidden",
              "Browser Origin must exactly match this remote Control UI origin.",
            );
          }
          const pathname = new URL(input.pathAndQuery, presentation.publicOrigin).pathname;
          const kind = pathname === (host.controlUiBasePath || "/") ? "main" : "auxiliary";
          if (
            kind === "auxiliary" &&
            !["/desktop/observe", "/desktop/audio", "/browser/screencast"].includes(pathname)
          ) {
            throw new GatewayControlUiIngressError(
              "forbidden",
              "WebSocket route is outside the Control UI ingress surface.",
            );
          }
          if (sockets[kind] >= 2) {
            throw new GatewayControlUiIngressError(
              "limit-exceeded",
              "Remote Control UI socket concurrency quota exceeded.",
            );
          }
          sockets[kind] += 1;
          const release = () => {
            sockets[kind] -= 1;
          };
          let result: Awaited<ReturnType<typeof transport.openWebSocket>> | undefined;
          try {
            result = await transport.openWebSocket(input);
            void result.socket.closed.then(release, release);
            assertHandleCurrent();
            return { protocol: result.protocol, socket: result.socket };
          } catch (error) {
            if (result) {
              void closeHandle();
            } else {
              release();
            }
            throw error;
          }
        },
        close: closeHandle,
      };
      return Object.freeze(handle);
    }
    const binding: GatewayIngressPrincipalBindingV1 = {
      request: requestPrincipal,
      openControlUi,
      close: closeBinding,
    };
    assertPrincipalCurrent();
    return Object.freeze(binding);
  }
  return {
    capabilityVersion: 2,
    bindPrincipal,
    async open(options) {
      const binding = await bindPrincipal(options);
      try {
        const handle = await binding.openControlUi(options);
        return Object.freeze({ ...handle, close: () => binding.close() });
      } catch (error) {
        void binding.close();
        throw error;
      }
    },
  };
}
