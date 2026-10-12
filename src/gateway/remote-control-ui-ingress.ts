import { validateHeaderValue } from "node:http";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
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
import { isOperatorScope } from "./operator-scopes.js";
import type { RemoteControlUiIngressContext } from "./remote-control-ui-context.js";
import { resolveRemoteControlUiHttpRoute } from "./remote-control-ui-http-routing.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createRemoteControlUiTransport } from "./remote-control-ui-transport.js";
import { prepareRemoteIngressPrincipal } from "./remote-ingress-principal.js";
import { requestRemoteIngressGateway } from "./remote-ingress-request.js";

const MAX_HANDLES_PER_PLUGIN = 32;
const MAX_HTTP_PER_HANDLE = 16;
const MAX_HTTP_PER_PLUGIN = 64;
const MAX_SOCKETS_PER_PLUGIN = 8;
// A maximum-sized message can occupy both a wire buffer and a decoded queue.
const MAX_BUFFERED_BYTES_PER_PLUGIN = 64 * 1024 * 1024;
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

type PluginQuota = {
  bindings: number;
  handles: number;
  http: number;
  sockets: number;
  bytes: number;
};
const quotas = new WeakMap<GatewayControlUiIngressHost, Map<string, PluginQuota>>();

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
  if (!Array.isArray(input) || input.length > 64) {
    invalid("Remote Control UI requests support at most 64 headers.");
  }
  let bytes = 0;
  const headers: [string, string][] = [];
  for (const [rawName, value] of input) {
    if (
      typeof rawName !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(rawName)
    ) {
      invalid("Remote Control UI request headers are malformed.");
    }
    bytes += Buffer.byteLength(rawName) + Buffer.byteLength(value);
    if (bytes > 16 * 1024) {
      invalid("Remote Control UI request headers exceed 16 KiB.");
    }
    const name = rawName.toLowerCase();
    try {
      validateHeaderValue(name, value);
    } catch {
      invalid("Remote Control UI request header values must be valid HTTP bytes.");
    }
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
    typeof options.audienceId !== "string" ||
    !options.audienceId ||
    options.audienceId.length > 256 ||
    containsAsciiControlCharacter(options.audienceId)
  ) {
    invalid("audienceId must be a nonempty opaque identity of at most 256 characters.");
  }
  if (
    !options.principal ||
    (options.principal.kind !== "owner" && options.principal.kind !== "person") ||
    (options.principal.kind === "person" &&
      (typeof options.principal.profileId !== "string" || !options.principal.profileId.trim()))
  ) {
    invalid("principal must explicitly select owner or an existing verified person profile.");
  }
  if (
    !Array.isArray(options.operatorScopeCeiling) ||
    options.operatorScopeCeiling.some((scope) => !isOperatorScope(scope))
  ) {
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
  let pluginQuotas = quotas.get(host);
  if (!pluginQuotas) {
    pluginQuotas = new Map();
    quotas.set(host, pluginQuotas);
  }
  let quota = pluginQuotas.get(pluginId);
  if (!quota) {
    quota = { bindings: 0, handles: 0, http: 0, sockets: 0, bytes: 0 };
    pluginQuotas.set(pluginId, quota);
  }
  const pluginQuota = quota;
  async function bindPrincipal(
    options: GatewayIngressPrincipalOptionsV1,
  ): Promise<GatewayIngressPrincipalBindingV1> {
    const operatorScopeCeiling = validatePrincipalOptions(options);
    const principal = Object.freeze({ ...options.principal });
    const lifetime = new AbortController();
    const grantSignal = AbortSignal.any([
      params.signal,
      host.signal,
      options.signal,
      lifetime.signal,
    ]);
    const grantAssertion = options.assertCurrent;
    const assertGrant = () => {
      grantSignal.throwIfAborted();
      try {
        params.assertCurrent();
        grantAssertion();
      } catch (error) {
        lifetime.abort(error);
        throw error;
      }
    };
    assertGrant();
    if (pluginQuota.bindings >= MAX_HANDLES_PER_PLUGIN) {
      throw new GatewayControlUiIngressError(
        "limit-exceeded",
        "Remote ingress plugin binding quota exceeded.",
      );
    }
    pluginQuota.bindings += 1;
    let preparedAuthority: Awaited<ReturnType<typeof prepareRemoteIngressPrincipal>> | undefined;
    try {
      preparedAuthority = await prepareRemoteIngressPrincipal({
        principal,
        operatorScopeCeiling,
        getRuntimeConfig: () => host.getRuntimeConfig(),
        getResolvedAuth: () => host.getResolvedAuth(),
        signal: grantSignal,
        assertCurrent: assertGrant,
      });
      assertGrant();
    } catch (error) {
      preparedAuthority?.close();
      pluginQuota.bindings -= 1;
      lifetime.abort(error);
      throw error;
    }
    const authority = preparedAuthority;
    const signal = authority.signal;
    const resolvePrincipal = () => authority.resolve();
    const assertCurrent = () => {
      authority.resolve().assertCurrent();
    };
    const handles = new Set<GatewayControlUiIngressV2>();
    const work = new Set<Promise<unknown>>();
    const trackWork = <T>(promise: Promise<T>): Promise<T> => {
      work.add(promise);
      void promise.then(
        () => work.delete(promise),
        () => work.delete(promise),
      );
      return promise;
    };
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          await Promise.all([...handles].map((handle) => handle.close()));
          while (work.size) {
            await Promise.allSettled(work);
          }
          authority.close();
          pluginQuota.bindings -= 1;
          signal.removeEventListener("abort", onAbort);
        });
        lifetime.abort(
          new GatewayControlUiIngressError("closed", "Remote ingress binding is closed."),
        );
      }
      return closing;
    };
    const onAbort = () => {
      void close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const requestGateway = async <T>(
      method: string,
      requestParams: Record<string, unknown>,
      requestOptions?: { signal?: AbortSignal },
      ingressContext?: RemoteControlUiIngressContext,
    ): Promise<T> => {
      assertCurrent();
      return trackWork(
        requestRemoteIngressGateway<T>({
          host,
          pluginId,
          resolvePrincipal,
          assertCurrent,
          signal,
          trackWork,
          method,
          params: requestParams,
          requestSignal: requestOptions?.signal,
          ingressContext,
        }),
      );
    };
    const binding: GatewayIngressPrincipalBindingV1 = {
      request: requestGateway,
      async openControlUi(presentationOptions) {
        assertCurrent();
        const handle = await openControlUi(presentationOptions, {
          principal,
          operatorScopeCeiling,
          resolvePrincipal,
          audienceId: optionsAudienceId,
          signal,
          assertCurrent,
          requestGateway,
        });
        const owned: GatewayControlUiIngressV2 = Object.freeze({
          ...handle,
          async close() {
            await handle.close();
            handles.delete(owned);
          },
        });
        handles.add(owned);
        try {
          assertCurrent();
        } catch (error) {
          await owned.close();
          throw error;
        }
        return owned;
      },
      close,
    };
    const optionsAudienceId = options.audienceId;
    if (signal.aborted) {
      await close();
      assertCurrent();
    }
    return Object.freeze(binding);
  }
  async function openControlUi(
    options: GatewayControlUiIngressPresentationOptionsV1,
    bound: Pick<
      RemoteControlUiIngressContext,
      | "principal"
      | "operatorScopeCeiling"
      | "resolvePrincipal"
      | "audienceId"
      | "signal"
      | "assertCurrent"
    > & {
      requestGateway<T>(
        method: string,
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
        ingressContext?: RemoteControlUiIngressContext,
      ): Promise<T>;
    },
  ): Promise<GatewayControlUiIngressV2> {
    const presentation = {
      ...validatePresentation(options),
      operatorScopeCeiling: bound.operatorScopeCeiling,
    };
    const gateway = host.getRuntimeConfig().gateway;
    const originPolicy = {
      publicOrigin: gateway?.publicOrigin,
      allowedOrigins: gateway?.controlUi?.allowedOrigins?.slice(),
      hostFallback: gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    };
    const lifetime = new AbortController();
    const signal = AbortSignal.any([bound.signal, lifetime.signal]);
    const assertCurrent = () => {
      if (signal.aborted) {
        throw new GatewayControlUiIngressError("closed", "Remote Control UI ingress is closed.");
      }
      try {
        bound.assertCurrent();
      } catch (error) {
        lifetime.abort(error);
        throw error;
      }
      const config = host.getRuntimeConfig();
      const current = config.gateway;
      const origins = current?.controlUi?.allowedOrigins;
      if (
        current?.controlUi?.enabled === false ||
        current?.publicOrigin !== originPolicy.publicOrigin ||
        current?.controlUi?.dangerouslyAllowHostHeaderOriginFallback !==
          originPolicy.hostFallback ||
        (origins === undefined) !== (originPolicy.allowedOrigins === undefined) ||
        origins?.length !== originPolicy.allowedOrigins?.length ||
        origins?.some((origin, index) => origin !== originPolicy.allowedOrigins?.[index])
      ) {
        const error = new GatewayControlUiIngressError(
          "closed",
          "Control UI origin policy changed; open a new ingress handle under the current policy.",
        );
        lifetime.abort(error);
        throw error;
      }
    };
    assertCurrent();
    if (pluginQuota.handles >= MAX_HANDLES_PER_PLUGIN) {
      throw new GatewayControlUiIngressError(
        "limit-exceeded",
        "Remote Control UI plugin handle quota exceeded.",
      );
    }
    pluginQuota.handles += 1;
    const work = new Set<Promise<unknown>>();
    const context: RemoteControlUiIngressContext = Object.freeze({
      ...presentation,
      pluginId,
      audienceId: bound.audienceId,
      principal: bound.principal,
      resolvePrincipal: bound.resolvePrincipal,
      signal,
      assertCurrent,
      trackWork<T>(promise: Promise<T>): Promise<T> {
        work.add(promise);
        void promise.then(
          () => work.delete(promise),
          () => work.delete(promise),
        );
        return promise;
      },
    });
    const transport = createRemoteControlUiTransport({
      context,
      host,
      reserveBytes(bytes) {
        assertCurrent();
        if (bytes > MAX_BUFFERED_BYTES_PER_PLUGIN - pluginQuota.bytes) {
          throw new GatewayControlUiIngressError(
            "limit-exceeded",
            "Remote Control UI plugin buffer quota exceeded.",
          );
        }
        pluginQuota.bytes += bytes;
        let held = true;
        return () => {
          if (held) {
            held = false;
            pluginQuota.bytes -= bytes;
          }
        };
      },
    });
    let http = 0;
    const sockets = { main: 0, auxiliary: 0 };
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) {
        // Publish closure before starting cleanup, including recursive abort callbacks.
        closing = Promise.resolve().then(async () => {
          await transport.close();
          while (work.size) {
            await Promise.allSettled(work);
          }
          pluginQuota.handles -= 1;
          signal.removeEventListener("abort", onAbort);
        });
        lifetime.abort();
      }
      return closing;
    };
    const onAbort = () => {
      void close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const handle: GatewayControlUiIngressV2 = {
      async requestGateway(method, requestParams, requestOptions) {
        assertCurrent();
        const requestSignal = requestOptions?.signal
          ? AbortSignal.any([signal, requestOptions.signal])
          : signal;
        return context.trackWork(
          bound.requestGateway(method, requestParams, { signal: requestSignal }, context),
        );
      },
      presentation: Object.freeze({
        basePath: host.controlUiBasePath,
        publicOrigin: presentation.publicOrigin,
        sandboxOrigin: presentation.sandboxOrigin,
        operatorScopeCeiling: presentation.operatorScopeCeiling,
      }),
      async request(input) {
        assertCurrent();
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
        if (http >= MAX_HTTP_PER_HANDLE || pluginQuota.http >= MAX_HTTP_PER_PLUGIN) {
          throw new GatewayControlUiIngressError(
            "limit-exceeded",
            "Remote Control UI HTTP concurrency quota exceeded.",
          );
        }
        http += 1;
        pluginQuota.http += 1;
        let held = true;
        const release = () => {
          if (held) {
            held = false;
            http -= 1;
            pluginQuota.http -= 1;
          }
        };
        let result: Awaited<ReturnType<typeof transport.request>> | undefined;
        try {
          result = await transport.request({ ...input, headers });
          void result.completion.then(release, release);
          assertCurrent();
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
            await result.response.body?.cancel(error).catch(() => undefined);
            await result.completion;
          } else {
            release();
          }
          throw error;
        }
      },
      async openWebSocket(input) {
        assertCurrent();
        validatePath(input.pathAndQuery);
        if (input.origin !== presentation.publicOrigin) {
          throw new GatewayControlUiIngressError(
            "forbidden",
            "Browser Origin must exactly match this remote Control UI origin.",
          );
        }
        if (
          input.protocols.length > 8 ||
          new Set(input.protocols).size !== input.protocols.length ||
          input.protocols.some(
            (value) => value.length > 128 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(value),
          )
        ) {
          invalid("WebSocket subprotocols must be bounded HTTP tokens.");
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
        if (sockets[kind] >= 2 || pluginQuota.sockets >= MAX_SOCKETS_PER_PLUGIN) {
          throw new GatewayControlUiIngressError(
            "limit-exceeded",
            "Remote Control UI socket concurrency quota exceeded.",
          );
        }
        sockets[kind] += 1;
        pluginQuota.sockets += 1;
        let held = true;
        const release = () => {
          if (held) {
            held = false;
            sockets[kind] -= 1;
            pluginQuota.sockets -= 1;
          }
        };
        let result: Awaited<ReturnType<typeof transport.openWebSocket>> | undefined;
        try {
          result = await transport.openWebSocket(input);
          void result.completion.then(release, release);
          assertCurrent();
          return { protocol: result.protocol, socket: result.socket };
        } catch (error) {
          if (result) {
            await close();
          } else {
            release();
          }
          throw error;
        }
      },
      close,
    };
    return Object.freeze(handle);
  }
  return {
    capabilityVersion: 2,
    bindPrincipal,
    async open(options) {
      validatePresentation(options);
      const binding = await bindPrincipal(options);
      try {
        const handle = await binding.openControlUi(options);
        return Object.freeze({ ...handle, close: () => binding.close() });
      } catch (error) {
        await binding.close();
        throw error;
      }
    },
  };
}
