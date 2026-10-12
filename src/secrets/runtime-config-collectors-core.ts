/** Collects core config secret refs during runtime preparation. */
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource } from "../agents/agent-scope-config.js";
import {
  resolveConfiguredTalkRealtimeProviderId,
  resolveConfiguredTalkSpeechProviderId,
} from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  resolveConfiguredMediaEntryCapabilities,
  resolveEffectiveMediaEntryCapabilities,
} from "../media-understanding/entry-capabilities.js";
import { buildMediaUnderstandingCapabilityRegistry } from "../media-understanding/provider-capability-registry.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { resolveVoiceModelRefs } from "../tts/voice-models.js";
import { getPath } from "./path-utils.js";
import { PROVIDER_REQUEST_SECRET_FIELD_GROUPS } from "./provider-request-secret-fields.js";
import { collectAgentMemorySearchAssignments } from "./runtime-config-collectors-memory.js";
import { collectAgentSandboxAssignments } from "./runtime-config-collectors-sandbox.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "./runtime-media-secret-owner.js";
import {
  collectCanonicalSecretInputAssignment as collectSecretInputAssignment,
  createConfigSecretInputCollector,
  type SecretAssignmentOwner,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type ProviderLike = {
  apiKey?: unknown;
  headers?: unknown;
  request?: unknown;
  enabled?: unknown;
};

type SkillEntryLike = Pick<ProviderLike, "apiKey" | "enabled">;

type ConfigCollectorParams = {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
};

function collectModelOrSkillAssignments(params: {
  entries: Record<string, ProviderLike>;
  kind: "model" | "skill";
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const collect = createConfigSecretInputCollector(params);
  const isModel = params.kind === "model";
  const pathPrefix = isModel ? "models.providers" : "skills.entries";
  for (const [id, entry] of Object.entries(params.entries)) {
    const active = entry.enabled !== false;
    const entryPath = appendConfigPathSegment(pathPrefix, id);
    const activity = {
      active,
      inactiveReason: isModel ? "provider is disabled." : "skill entry is disabled.",
      owner: {
        ownerKind: isModel ? "provider" : "capability",
        // Skill identity is also consumed by prompt filtering and env injection.
        ownerId: isModel ? (normalizeOptionalLowercaseString(id) ?? id) : `skill:${id}`,
        requiredForGateway: false,
        disposition: "isolate",
        contract: entry,
      } satisfies SecretAssignmentOwner,
    };
    collect(entry, "apiKey", `${entryPath}.apiKey`, activity);
    if (!isModel) {
      continue;
    }
    const headers = isRecord(entry.headers) ? entry.headers : undefined;
    if (headers) {
      for (const headerKey of Object.keys(headers)) {
        collect(
          headers,
          headerKey,
          appendConfigPathSegment(`${entryPath}.headers`, headerKey),
          activity,
        );
      }
    }

    const request = isRecord(entry.request) ? entry.request : undefined;
    if (request) {
      collectProviderRequestAssignments({
        request,
        pathPrefix: `${entryPath}.request`,
        defaults: params.defaults,
        context: params.context,
        ...activity,
      });
    }
  }
}

function findTalkProviderConfig(providers: unknown, providerId: string) {
  if (!isRecord(providers)) {
    return undefined;
  }
  const id = findNormalizedProviderKey(providers, providerId);
  const config = id ? providers[id] : undefined;
  return id && isRecord(config) ? { id, config } : undefined;
}

function collectTalkAssignments(params: ConfigCollectorParams): void {
  const talk = params.config.talk as Record<string, unknown> | undefined;
  if (!isRecord(talk)) {
    return;
  }
  for (const surface of ["speech", "realtime"] as const) {
    const section =
      surface === "speech" ? talk : isRecord(talk.realtime) ? talk.realtime : undefined;
    if (!section) {
      continue;
    }
    const configuredId =
      surface === "speech"
        ? resolveConfiguredTalkSpeechProviderId(params.config)
        : resolveConfiguredTalkRealtimeProviderId(params.config);
    const normalizedConfiguredId = normalizeOptionalLowercaseString(configuredId);
    const capability = surface === "speech" ? "speechProviders" : "realtimeVoiceProviders";
    const providerIds = normalizedConfiguredId
      ? params.context.manifestRegistry
        ? params.context.manifestRegistry.plugins
            .map((manifest) => manifest.contracts?.[capability])
            .find((ids) =>
              ids?.some((id) => normalizeOptionalLowercaseString(id) === normalizedConfiguredId),
            )
        : [normalizedConfiguredId]
      : undefined;
    const normalizedProviderIds = providerIds?.map(
      (id) => normalizeOptionalLowercaseString(id) ?? id,
    );
    const providerId = normalizedProviderIds?.[0];
    const selected = configuredId
      ? findTalkProviderConfig(section.providers, configuredId)
      : undefined;
    const inherited =
      surface === "speech" && providerId
        ? normalizedProviderIds
            .map((id) => findTalkProviderConfig(params.config.tts?.providers, id))
            .find((entry) => entry !== undefined)
        : undefined;
    const explicitModel =
      surface === "realtime"
        ? section.model
        : (selected?.config.model ??
          selected?.config.modelId ??
          inherited?.config.model ??
          inherited?.config.modelId);
    const voiceModel =
      explicitModel === undefined
        ? resolveVoiceModelRefs(params.config.agents?.defaults?.voiceModel).find((ref) =>
            normalizedProviderIds?.includes(ref.provider.toLowerCase()),
          )
        : undefined;
    const { providers: _providers, provider: _provider, ...realtimeDefaults } = section;
    const inheritedConfig =
      inherited && selected?.config.apiKey !== undefined
        ? Object.fromEntries(Object.entries(inherited.config).filter(([key]) => key !== "apiKey"))
        : inherited?.config;
    const owner = providerId
      ? ({
          ownerKind: "capability",
          ownerId: `talk:${surface}`,
          requiredForGateway: false,
          disposition: "isolate",
          contract: {
            provider: providerId,
            selectedProvider: configuredId,
            providerConfig: selected?.config,
            voiceModel,
            ...(surface === "realtime"
              ? {
                  ...realtimeDefaults,
                  canonicalProviderConfig: findTalkProviderConfig(section.providers, providerId)
                    ?.config,
                }
              : {
                  inheritedProviderConfig: inheritedConfig,
                  timeoutMs: params.config.tts?.timeoutMs,
                  maxTextLength: params.config.tts?.maxTextLength,
                }),
          },
        } satisfies SecretAssignmentOwner)
      : undefined;
    const inheritedKey =
      surface === "speech" && inherited && selected?.config.apiKey === undefined
        ? inherited
        : undefined;
    const entries = Object.entries(isRecord(section.providers) ? section.providers : {});
    if (inheritedKey && selected) {
      entries.push([inheritedKey.id, inheritedKey.config]);
    }
    for (const [id, config] of entries) {
      if (!isRecord(config)) {
        continue;
      }
      const isInherited = config === inheritedKey?.config;
      const destination = isInherited && selected ? selected.config : config;
      const normalized = normalizeOptionalLowercaseString(id);
      collectSecretInputAssignment({
        value: config.apiKey,
        path: isInherited
          ? `${appendConfigPathSegment("tts.providers", id)}.apiKey`
          : `${appendConfigPathSegment(`talk.${surface === "realtime" ? "realtime." : ""}providers`, id)}.apiKey`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: Boolean(
          isInherited ||
          (providerId &&
            (normalized === normalizedConfiguredId ||
              (surface === "realtime" && normalized === providerId))),
        ),
        inactiveReason: "Talk provider is not selected.",
        owner,
        apply: (resolved) => {
          destination.apiKey = resolved;
        },
      });
    }
  }
}

function collectGatewayAssignments(params: ConfigCollectorParams): void {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return;
  }
  const collect = createConfigSecretInputCollector(params);
  const controlUi = isRecord(gateway.controlUi) ? gateway.controlUi : undefined;
  const gatewaySurfaceStates = evaluateGatewayAuthSurfaceStates({
    config: params.config,
    env: params.context.env,
    defaults: params.defaults,
  });
  for (const surface of ["auth", "remote"] as const) {
    const target = gateway[surface];
    if (!isRecord(target)) {
      continue;
    }
    const owner =
      surface === "auth"
        ? ({
            ownerKind: "gateway",
            ownerId: "ingress-auth",
            requiredForGateway: true,
            disposition: "fail-closed",
            contract: target,
          } satisfies SecretAssignmentOwner)
        : undefined;
    for (const key of ["token", "password"] as const) {
      const path = `gateway.${surface}.${key}` as const;
      collect(target, key, path, {
        active: gatewaySurfaceStates[path].active,
        inactiveReason: gatewaySurfaceStates[path].reason,
        owner,
      });
    }
  }
  const controlUiGitHub = controlUi && isRecord(controlUi.github) ? controlUi.github : undefined;
  if (controlUiGitHub) {
    collect(controlUiGitHub, "token", "gateway.controlUi.github.token", {
      owner: {
        ownerKind: "capability",
        ownerId: "control-ui-github",
        requiredForGateway: false,
        disposition: "isolate",
        contract: controlUiGitHub,
      },
    });
  }
}

function collectProviderRequestAssignments(params: {
  request: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
  owner?: SecretAssignmentOwner;
}): void {
  const collect = createConfigSecretInputCollector(params);
  for (const { path, fields } of PROVIDER_REQUEST_SECRET_FIELD_GROUPS) {
    const target = getPath(params.request, [...path]);
    if (!isRecord(target)) {
      continue;
    }
    const pathPrefix = `${params.pathPrefix}.${path.join(".")}`;
    for (const key of fields === "*" ? Object.keys(target) : fields) {
      collect(target, key, appendConfigPathSegment(pathPrefix, key), {
        active: params.active,
        inactiveReason: params.inactiveReason,
        owner: params.owner,
      });
    }
  }
}

function collectMediaRequestAssignments(params: ConfigCollectorParams): void {
  const tools = isRecord(params.config.tools) ? params.config.tools : undefined;
  const media = isRecord(tools?.media) ? tools.media : undefined;
  if (!media) {
    return;
  }

  let providerRegistry: ReturnType<typeof buildMediaUnderstandingCapabilityRegistry> | undefined;
  const getProviderRegistry = () => {
    providerRegistry ??= buildMediaUnderstandingCapabilityRegistry(params.config);
    return providerRegistry;
  };
  const capabilityKeys = ["audio", "image", "video"] as const;
  const isCapabilityEnabled = (capability: (typeof capabilityKeys)[number]) =>
    (isRecord(media[capability]) ? media[capability] : undefined)?.enabled !== false;

  const models = media.models;
  if (Array.isArray(models)) {
    models.forEach((rawModel, index) => {
      if (!isRecord(rawModel) || !isRecord(rawModel.request)) {
        return;
      }
      const entry = rawModel as MediaUnderstandingModelConfig;
      const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(entry);
      // Shared models are active only for enabled capabilities; explicit tags also
      // keep provider metadata loading lazy when the config already has the answer.
      const capabilities =
        configuredCapabilities ??
        resolveEffectiveMediaEntryCapabilities({
          entry,
          providerRegistry: getProviderRegistry(),
        });
      const active = capabilities?.some((capability) => isCapabilityEnabled(capability)) ?? false;
      const inactiveReason =
        capabilities && capabilities.length > 0
          ? `all configured media capabilities for this shared model are disabled: ${capabilities.join(", ")}.`
          : "shared media model does not declare capabilities and none could be inferred from its provider.";
      collectProviderRequestAssignments({
        request: rawModel.request,
        pathPrefix: `tools.media.models[${index}].request`,
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason,
        owner: {
          ownerKind: "capability",
          ownerId: runtimeMediaModelSecretOwnerId(index),
          requiredForGateway: false,
          disposition: "isolate",
          contract: rawModel,
        },
      });
    });
  }

  for (const capability of capabilityKeys) {
    const section = isRecord(media[capability]) ? media[capability] : undefined;
    if (!section || !isRecord(section.request)) {
      continue;
    }
    const active = isCapabilityEnabled(capability);
    collectProviderRequestAssignments({
      request: section.request,
      pathPrefix: `tools.media.${capability}.request`,
      defaults: params.defaults,
      context: params.context,
      active,
      inactiveReason: `${capability} media understanding is disabled.`,
      owner: {
        ownerKind: "capability",
        ownerId: runtimeMediaRequestSecretOwnerId(capability),
        requiredForGateway: false,
        disposition: "isolate",
        contract: section,
      },
    });
  }
}

function collectMessagesTtsAssignments(params: ConfigCollectorParams): void {
  const tts = params.config.tts as Record<string, unknown> | undefined;
  if (!isRecord(tts)) {
    return;
  }
  collectTtsApiKeyAssignments({
    tts,
    pathPrefix: "tts",
    defaults: params.defaults,
    context: params.context,
  });
}

function collectAgentTtsAssignments(params: ConfigCollectorParams): void {
  for (const { entry, source } of listAgentEntriesWithSource(params.config)) {
    if (!isRecord(entry.tts)) {
      continue;
    }
    collectTtsApiKeyAssignments({
      tts: entry.tts,
      pathPrefix:
        source.kind === "entries"
          ? `${appendConfigPathSegment("agents.entries", source.key)}.tts`
          : `agents.list[${source.index}].tts`,
      defaults: params.defaults,
      context: params.context,
    });
  }
}

function collectCronAssignments(params: ConfigCollectorParams): void {
  const cron = params.config.cron as Record<string, unknown> | undefined;
  if (!isRecord(cron)) {
    return;
  }
  const collect = createConfigSecretInputCollector(params);
  collect(cron, "webhookToken", "cron.webhookToken", {
    owner: {
      ownerKind: "capability",
      ownerId: "cron-webhook",
      requiredForGateway: false,
      disposition: "isolate",
      contract: cron,
    },
  });
}

/** Collects SecretRef assignments from core non-plugin config surfaces. */
export function collectCoreConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  agentId?: string;
}): void {
  const providers = params.config.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    collectModelOrSkillAssignments({
      entries: providers,
      kind: "model",
      defaults: params.defaults,
      context: params.context,
    });
  }

  const skillEntries = params.config.skills?.entries as Record<string, SkillEntryLike> | undefined;
  if (skillEntries) {
    collectModelOrSkillAssignments({
      entries: skillEntries,
      kind: "skill",
      defaults: params.defaults,
      context: params.context,
    });
  }

  collectAgentMemorySearchAssignments(params);
  collectTalkAssignments(params);
  collectGatewayAssignments(params);
  collectAgentSandboxAssignments(params);
  collectMessagesTtsAssignments(params);
  collectAgentTtsAssignments(params);
  collectCronAssignments(params);
  collectMediaRequestAssignments(params);
}
