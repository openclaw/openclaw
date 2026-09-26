import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveProviderConfigSecretInput } from "../agents/model-auth-provider-config.js";
import { findConfiguredProviderModel } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRedactingStreamWriter } from "../logging/redacting-stream.js";
import { captureSecretRedactionRegistrySnapshot } from "../logging/secret-redaction-registry.js";
import {
  createProviderModelCatalogIdNormalizer,
  resolveProviderModelRoutes,
} from "../plugins/provider-model-routes.js";
import { startSecretEgressProxyServer } from "./egress-proxy/proxy-server.js";
import { normalizeExactAllowedHost } from "./exact-hostname.js";
import { resolveSecretRefString } from "./resolve.js";
import { sealSecretSentinel } from "./sentinel.js";

export type ConfiguredModelEgress = {
  /** Opaque API-key substitute for the remote application. */
  sentinel: string;
  baseUrl: string;
  model: string;
  allowedHosts: readonly string[];
  /** Authenticated loopback proxy environment; keep it on the credential-owning host. */
  hostEnv: Readonly<Record<string, string>>;
  /** Public trust bundle contents, suitable for the remote application's CA file. */
  caBundle: string;
  onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
};

export type ConfiguredModelEgressOptions = {
  config: OpenClawConfig;
  provider: string;
  model: string;
  signal?: AbortSignal;
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
};

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function resolveModelEgressSelection(params: ConfiguredModelEgressOptions) {
  const provider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  if (!provider || !model) {
    throw new Error("Model egress requires an explicit provider and model");
  }
  const { providerConfig, ref } = resolveProviderConfigSecretInput(params.config, provider);
  if (!providerConfig) {
    throw new Error("Model egress requires a configured provider");
  }
  if (!ref || (providerConfig.auth !== undefined && providerConfig.auth !== "api-key")) {
    throw new Error(
      "Model egress requires a configured API-key SecretRef; auth profiles and OAuth are unsupported",
    );
  }
  const configuredModel = findConfiguredProviderModel(
    providerConfig,
    provider,
    model,
    createProviderModelCatalogIdNormalizer(provider),
  );
  if (
    hasEntries(providerConfig.headers) ||
    hasEntries(configuredModel?.headers) ||
    hasEntries(providerConfig.request) ||
    providerConfig.authHeader === false ||
    providerConfig.localService !== undefined
  ) {
    throw new Error(
      "Model egress does not support custom request headers, authentication, proxy, TLS, or local-service configuration",
    );
  }
  const resolution = resolveProviderModelRoutes({
    provider,
    modelId: model,
    config: params.config,
  });
  if (resolution?.kind === "incompatible") {
    throw new Error(resolution.message);
  }
  const route = resolution
    ? resolution.kind === "routes"
      ? resolution.routes.find((candidate) => candidate.authRequirement === "api-key")
      : undefined
    : {
        api: configuredModel?.api ?? providerConfig.api,
        baseUrl: configuredModel?.baseUrl ?? providerConfig.baseUrl,
      };
  if (!route?.baseUrl || (route.api !== "openai-responses" && route.api !== "openai-completions")) {
    throw new Error("Model egress requires an OpenAI-compatible API-key model route");
  }
  let url: URL;
  try {
    url = new URL(route.baseUrl);
  } catch {
    throw new Error("Model egress requires a valid HTTPS model base URL");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Model egress requires an HTTPS model base URL on port 443 without credentials, query, or fragment",
    );
  }
  return {
    provider,
    model,
    ref,
    baseUrl: url.href,
    allowedHosts: [normalizeExactAllowedHost(url.hostname)],
  };
}

/** Owns one explicit CLI job's protected model credential and its revocable egress path. */
export async function withConfiguredModelEgress<T>(
  params: ConfiguredModelEgressOptions,
  run: (egress: ConfiguredModelEgress) => Promise<T>,
): Promise<T> {
  params.signal?.throwIfAborted();
  const selection = resolveModelEgressSelection(params);
  const apiKey = await resolveSecretRefString(selection.ref, { config: params.config });
  params.signal?.throwIfAborted();
  if (Buffer.byteLength(apiKey) > 64 * 1024) {
    throw new Error("Model egress API key exceeds the protected credential size limit");
  }
  const sentinel = sealSecretSentinel(apiKey, { label: `model-egress:${selection.provider}` });
  await using resources = new AsyncDisposableStack();
  const caDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-egress-"));
  resources.defer(() => fs.rm(caDir, { recursive: true, force: true }));
  params.signal?.throwIfAborted();
  const proxy = await startSecretEgressProxyServer({
    caDir,
    allowedHosts: selection.allowedHosts,
    onAudit: () => {},
  });
  resources.defer(() => proxy.stop());
  params.signal?.throwIfAborted();
  const grant = proxy.registerProcess([
    {
      name: `${selection.provider} model API key`,
      sentinel,
      allowedHosts: selection.allowedHosts,
    },
  ]);
  resources.defer(() => {
    grant.revoke();
    params.signal?.removeEventListener("abort", grant.revoke);
  });
  params.signal?.addEventListener("abort", grant.revoke, { once: true });
  params.signal?.throwIfAborted();
  const caBundle = await fs.readFile(grant.env.NODE_EXTRA_CA_CERTS!, "utf8");
  params.signal?.throwIfAborted();
  const values = [...captureSecretRedactionRegistrySnapshot().values, grant.env.HTTPS_PROXY!];
  const output = (stream: "stdout" | "stderr") =>
    createRedactingStreamWriter(
      {
        write(text) {
          params.onOutput?.(text, stream);
          return true;
        },
      },
      values,
    );
  const stdout = output("stdout");
  const stderr = output("stderr");
  resources.defer(stdout.flush);
  resources.defer(stderr.flush);
  const result = await run({
    sentinel,
    baseUrl: selection.baseUrl,
    model: selection.model,
    allowedHosts: selection.allowedHosts,
    hostEnv: grant.env,
    caBundle,
    onOutputChunk: params.onOutput
      ? (chunk, stream) => {
          (stream === "stdout" ? stdout : stderr).write(chunk);
        }
      : undefined,
  });
  params.signal?.throwIfAborted();
  return result;
}
