import type { OpenClawConfig } from "../config/config.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces.js";
import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type ProviderLike = {
  apiKey?: unknown;
  headers?: unknown;
  enabled?: unknown;
};

type SkillEntryLike = {
  apiKey?: unknown;
  enabled?: unknown;
};

function collectModelProviderAssignments(params: {
  providers: Record<string, ProviderLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const providerIsActive = provider.enabled !== false;
    collectSecretInputAssignment({
      value: provider.apiKey,
      path: `models.providers.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: providerIsActive,
      inactiveReason: "provider is disabled.",
      apply: (value) => {
        provider.apiKey = value;
      },
    });
    const headers = isRecord(provider.headers) ? provider.headers : undefined;
    if (!headers) {
      continue;
    }
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      collectSecretInputAssignment({
        value: headerValue,
        path: `models.providers.${providerId}.headers.${headerKey}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: providerIsActive,
        inactiveReason: "provider is disabled.",
        apply: (value) => {
          headers[headerKey] = value;
        },
      });
    }
  }
}

function collectSkillAssignments(params: {
  entries: Record<string, SkillEntryLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [skillKey, entry] of Object.entries(params.entries)) {
    collectSecretInputAssignment({
      value: entry.apiKey,
      path: `skills.entries.${skillKey}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: entry.enabled !== false,
      inactiveReason: "skill entry is disabled.",
      apply: (value) => {
        entry.apiKey = value;
      },
    });
  }
}

function collectAgentMemorySearchAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = params.config.agents as Record<string, unknown> | undefined;
  if (!isRecord(agents)) {
    return;
  }
  const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsMemorySearch = isRecord(defaultsConfig?.memorySearch)
    ? defaultsConfig.memorySearch
    : undefined;
  const defaultsEnabled = defaultsMemorySearch?.enabled !== false;

  const list = Array.isArray(agents.list) ? agents.list : [];
  let hasEnabledAgentWithoutOverride = false;
  for (const rawAgent of list) {
    if (!isRecord(rawAgent)) {
      continue;
    }
    if (rawAgent.enabled === false) {
      continue;
    }
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    if (memorySearch?.enabled === false) {
      continue;
    }
    if (!memorySearch || !Object.prototype.hasOwnProperty.call(memorySearch, "remote")) {
      hasEnabledAgentWithoutOverride = true;
      continue;
    }
    const remote = isRecord(memorySearch.remote) ? memorySearch.remote : undefined;
    if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) {
      hasEnabledAgentWithoutOverride = true;
      continue;
    }
  }

  if (defaultsMemorySearch && isRecord(defaultsMemorySearch.remote)) {
    const remote = defaultsMemorySearch.remote;
    collectSecretInputAssignment({
      value: remote.apiKey,
      path: "agents.defaults.memorySearch.remote.apiKey",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: defaultsEnabled && (hasEnabledAgentWithoutOverride || list.length === 0),
      inactiveReason: hasEnabledAgentWithoutOverride
        ? undefined
        : "all enabled agents override memorySearch.remote.apiKey.",
      apply: (value) => {
        remote.apiKey = value;
      },
    });
  }

  list.forEach((rawAgent, index) => {
    if (!isRecord(rawAgent)) {
      return;
    }
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    if (!memorySearch) {
      return;
    }
    const remote = isRecord(memorySearch.remote) ? memorySearch.remote : undefined;
    if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) {
      return;
    }
    const enabled = rawAgent.enabled !== false && memorySearch.enabled !== false;
    collectSecretInputAssignment({
      value: remote.apiKey,
      path: `agents.list.${index}.memorySearch.remote.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: "agent or memorySearch override is disabled.",
      apply: (value) => {
        remote.apiKey = value;
      },
    });
  });
}

function collectTalkAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const talk = params.config.talk as Record<string, unknown> | undefined;
  if (!isRecord(talk)) {
    return;
  }
  collectSecretInputAssignment({
    value: talk.apiKey,
    path: "talk.apiKey",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    apply: (value) => {
      talk.apiKey = value;
    },
  });
  const providers = talk.providers;
  if (!isRecord(providers)) {
    return;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    collectSecretInputAssignment({
      value: providerConfig.apiKey,
      path: `talk.providers.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      apply: (value) => {
        providerConfig.apiKey = value;
      },
    });
  }
}

function collectGatewayAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return;
  }
  const auth = isRecord(gateway.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway.remote) ? gateway.remote : undefined;
  const gatewaySurfaceStates = evaluateGatewayAuthSurfaceStates({
    config: params.config,
    env: params.context.env,
    defaults: params.defaults,
  });
  if (auth) {
    collectSecretInputAssignment({
      value: auth.token,
      path: "gateway.auth.token",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.auth.token"].active,
      inactiveReason: gatewaySurfaceStates["gateway.auth.token"].reason,
      apply: (value) => {
        auth.token = value;
      },
    });
    collectSecretInputAssignment({
      value: auth.password,
      path: "gateway.auth.password",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.auth.password"].active,
      inactiveReason: gatewaySurfaceStates["gateway.auth.password"].reason,
      apply: (value) => {
        auth.password = value;
      },
    });
  }
  if (remote) {
    collectSecretInputAssignment({
      value: remote.token,
      path: "gateway.remote.token",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.remote.token"].active,
      inactiveReason: gatewaySurfaceStates["gateway.remote.token"].reason,
      apply: (value) => {
        remote.token = value;
      },
    });
    collectSecretInputAssignment({
      value: remote.password,
      path: "gateway.remote.password",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: gatewaySurfaceStates["gateway.remote.password"].active,
      inactiveReason: gatewaySurfaceStates["gateway.remote.password"].reason,
      apply: (value) => {
        remote.password = value;
      },
    });
  }
}

function collectMessagesTtsAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const messages = params.config.messages as Record<string, unknown> | undefined;
  if (!isRecord(messages) || !isRecord(messages.tts)) {
    return;
  }
  collectTtsApiKeyAssignments({
    tts: messages.tts,
    pathPrefix: "messages.tts",
    defaults: params.defaults,
    context: params.context,
  });
}

function collectToolsWebSearchAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const tools = params.config.tools as Record<string, unknown> | undefined;
  if (!isRecord(tools) || !isRecord(tools.web) || !isRecord(tools.web.search)) {
    return;
  }
  const search = tools.web.search;
  const searchEnabled = search.enabled !== false;
  const rawProvider =
    typeof search.provider === "string" ? search.provider.trim().toLowerCase() : "";
  const selectedProvider =
    rawProvider === "brave" ||
    rawProvider === "gemini" ||
    rawProvider === "grok" ||
    rawProvider === "kimi" ||
    rawProvider === "perplexity"
      ? rawProvider
      : undefined;
  const paths = [
    "apiKey",
    "gemini.apiKey",
    "grok.apiKey",
    "kimi.apiKey",
    "perplexity.apiKey",
  ] as const;
  for (const path of paths) {
    const [scope, field] = path.includes(".") ? path.split(".", 2) : [undefined, path];
    const target = scope ? search[scope] : search;
    if (!isRecord(target)) {
      continue;
    }
    const active = scope
      ? searchEnabled && (selectedProvider === undefined || selectedProvider === scope)
      : searchEnabled && (selectedProvider === undefined || selectedProvider === "brave");
    const inactiveReason = !searchEnabled
      ? "tools.web.search is disabled."
      : scope
        ? selectedProvider === undefined
          ? undefined
          : `tools.web.search.provider is "${selectedProvider}".`
        : selectedProvider === undefined
          ? undefined
          : `tools.web.search.provider is "${selectedProvider}".`;
    collectSecretInputAssignment({
      value: target[field],
      path: `tools.web.search.${path}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active,
      inactiveReason,
      apply: (value) => {
        target[field] = value;
      },
    });
  }
}

function collectCronAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const cron = params.config.cron as Record<string, unknown> | undefined;
  if (!isRecord(cron)) {
    return;
  }
  collectSecretInputAssignment({
    value: cron.webhookToken,
    path: "cron.webhookToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    apply: (value) => {
      cron.webhookToken = value;
    },
  });
}

function collectSandboxDockerEnvAssignments(params: {
  env: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active: boolean;
  inactiveReason?: string;
}): void {
  for (const [key, value] of Object.entries(params.env)) {
    collectSecretInputAssignment({
      value,
      path: `${params.pathPrefix}.${key}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      apply: (resolved) => {
        params.env[key] = resolved as string;
      },
    });
  }
}

function collectAgentSandboxDockerEnvAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const agents = params.config.agents as Record<string, unknown> | undefined;
  if (!isRecord(agents)) {
    return;
  }

  // Collect from agents.defaults.sandbox.docker.env
  const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsSandbox = isRecord(defaultsConfig?.sandbox) ? defaultsConfig.sandbox : undefined;
  const defaultsDocker = isRecord(defaultsSandbox?.docker) ? defaultsSandbox.docker : undefined;
  const defaultsEnv = isRecord(defaultsDocker?.env) ? defaultsDocker.env : undefined;

  // Collect from agents.list[].sandbox.docker.env (skip disabled agents)
  const list = Array.isArray(agents.list) ? agents.list : [];

  // Defaults env refs are always active because sandbox env is merged key-by-key
  // (global + agent), not replaced wholesale. An agent having its own env map does
  // not mean it overrides every key from defaults.
  if (defaultsEnv) {
    collectSandboxDockerEnvAssignments({
      env: defaultsEnv,
      pathPrefix: "agents.defaults.sandbox.docker.env",
      defaults: params.defaults,
      context: params.context,
      active: true,
    });
  }

  list.forEach((rawAgent, index) => {
    if (!isRecord(rawAgent)) {
      return;
    }
    const sandbox = isRecord(rawAgent.sandbox) ? rawAgent.sandbox : undefined;
    const docker = isRecord(sandbox?.docker) ? sandbox.docker : undefined;
    const env = isRecord(docker?.env) ? docker.env : undefined;
    if (env) {
      const enabled = rawAgent.enabled !== false;
      collectSandboxDockerEnvAssignments({
        env,
        pathPrefix: `agents.list.${index}.sandbox.docker.env`,
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "agent is disabled.",
      });
    }
  });
}

export function collectCoreConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const providers = params.config.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    collectModelProviderAssignments({
      providers,
      defaults: params.defaults,
      context: params.context,
    });
  }

  const skillEntries = params.config.skills?.entries as Record<string, SkillEntryLike> | undefined;
  if (skillEntries) {
    collectSkillAssignments({
      entries: skillEntries,
      defaults: params.defaults,
      context: params.context,
    });
  }

  collectAgentMemorySearchAssignments(params);
  collectAgentSandboxDockerEnvAssignments(params);
  collectTalkAssignments(params);
  collectGatewayAssignments(params);
  collectMessagesTtsAssignments(params);
  collectToolsWebSearchAssignments(params);
  collectCronAssignments(params);
}
