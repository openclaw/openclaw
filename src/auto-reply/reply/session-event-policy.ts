import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import { resolveModelProviderAuthConfig } from "../../agents/model-auth-provider-route.js";
import { buildAllowedModelSet } from "../../agents/model-selection-shared.js";
import {
  resolveProviderAuthAliasMap,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import { resolveScheduledToolCallerContext } from "../../agents/scheduled-tool-policy.js";
import { intersectSessionPermissionModes } from "../../agents/session-permission-exec-mode.js";
import { resolveChannelConfigActivationFacts } from "../../config/channel-config-activation.js";
import { resolveMergedModelProviderConfig } from "../../config/model-provider-config.js";
import { serializeConfigResolutionFacts } from "../../config/resolution-facts.js";
import { getRuntimeConfigCapture } from "../../config/runtime-config-capture-state.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import { intersectSessionToolOverrides } from "../../config/sessions/session-tool-overrides.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronJobToolPolicyContext } from "../../cron/execution-context-admission.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import type { CronStoredJob } from "../../cron/types.js";
import { parseConcreteConfigPathTokens } from "../../shared/dot-path.js";
import type { SessionEventTarget } from "./session-event-contract.js";

/** A delayed producer can retain restrictions, never replace current session authority. */
export function narrowSessionEventSettings(
  retained: SessionEventTarget["settings"],
  current: SessionEventTarget["settings"],
): NonNullable<SessionEventTarget["settings"]> {
  return {
    permissionMode: intersectSessionPermissionModes(
      retained?.permissionMode,
      current?.permissionMode,
    ),
    toolOverrides: intersectSessionToolOverrides(retained?.toolOverrides, current?.toolOverrides),
  };
}

/** One occurrence keeps its original policy while selected model consumers may change. */
export function captureSessionEventConfigPolicy(
  config: OpenClawConfig,
  agentId: string,
  job?: CronStoredJob,
) {
  const captured = job ? captureRuntimeConfig(config) : config;
  const publication = getRuntimeConfigSnapshotMetadata();
  let checkedConfig = config;
  let checkedPublication = publication;
  let changed = false;
  let matches = job ? captureScheduledSessionEventConfigPolicy(captured, agentId, job) : undefined;
  return {
    get changed() {
      return changed;
    },
    selectModel(selection: { provider: string; model: string }) {
      if (job) {
        matches = captureScheduledSessionEventConfigPolicy(captured, agentId, job, selection);
        // A fallback may consume auth that an earlier provider did not need.
        checkedConfig = config;
        checkedPublication = publication;
      }
    },
    assertCurrent(current: OpenClawConfig, routeChannels: Array<string | undefined>) {
      const currentPublication = getRuntimeConfigSnapshotMetadata();
      if (current === checkedConfig && currentPublication === checkedPublication) {
        return;
      }
      if (!matches?.(current, routeChannels)) {
        // Only this recorded refusal permits the handoff owner to re-admit unstarted work.
        changed = true;
        throw new Error("Session event configuration changed; inspect the run before retrying");
      }
      checkedConfig = current;
      checkedPublication = currentPublication;
    },
  };
}

/** Scheduled message actions re-admit their destination policy at each invocation. The
 * turn still owns its creator's channel ceilings and its automatic delivery route. */
export function captureScheduledSessionEventConfigPolicy(
  config: OpenClawConfig,
  agentId: string,
  job: CronStoredJob,
  selection?: { provider: string; model: string },
) {
  const captured = captureRuntimeConfig(config);
  const creatorChannel = resolveScheduledToolCallerContext({
    scheduledToolPolicy: resolveCronJobToolPolicyContext(job, resolveCronRunToolsAllow(job)),
  }).channel;
  const authProvider =
    selection &&
    resolveProviderIdForAuth(selection.provider, {
      config: resolveModelProviderAuthConfig({
        config: captured,
        provider: selection.provider,
        modelId: selection.model,
      }),
    });
  const storedAliases =
    selection && resolveProviderAuthAliasMap({ config: captured, storedCredential: true });
  const profileBinding =
    selection && resolveMergedModelProviderConfig(captured, selection.provider)?.apiKey;
  const relevantAuthProvider = (provider: string) =>
    !selection ||
    normalizeProviderId(provider) === normalizeProviderId(selection.provider) ||
    normalizeProviderId(provider) === authProvider;
  const profileIds = (value: OpenClawConfig) =>
    new Set(
      Object.entries(value.auth?.profiles ?? {})
        .filter(([id, profile]) => {
          const provider = normalizeProviderId(profile.provider);
          return (
            !selection ||
            (typeof profileBinding === "string" && id === profileBinding.trim()) ||
            (storedAliases?.[provider] ?? provider) === authProvider
          );
        })
        .map(([id]) => id),
    );
  const capturedProfileIds = selection ? profileIds(captured) : new Set<string>();
  const sameModelPolicy = (before: OpenClawConfig, after: OpenClawConfig) => {
    const policy = (value: OpenClawConfig) => [
      value.agents?.defaults?.modelPolicy,
      resolveAgentEntry(value, agentId)?.modelPolicy,
    ];
    if (!selection || isDeepStrictEqual(policy(before), policy(after))) {
      return true;
    }
    const allows = (cfg: OpenClawConfig) =>
      buildAllowedModelSet({
        cfg,
        agentId,
        catalog: [],
        defaultProvider: selection.provider,
      }).allows(selection);
    return allows(before) === allows(after);
  };
  return (current: OpenClawConfig, routeChannels: Array<string | undefined>) => {
    const channels = [
      ...new Set([creatorChannel, ...routeChannels].filter((id): id is string => Boolean(id))),
    ];
    const project = (
      {
        agents,
        auth,
        models,
        channels: channelConfig,
        logging: _logging,
        meta: _meta,
        ...global
      }: OpenClawConfig,
      profiles: ReadonlySet<string>,
    ) => ({
      ...global,
      models: selection
        ? {
            ...models,
            providers: Object.fromEntries(
              Object.entries(models?.providers ?? {}).filter(([provider]) =>
                relevantAuthProvider(provider),
              ),
            ),
          }
        : models,
      auth: selection
        ? {
            profiles: Object.fromEntries(
              Object.entries(auth?.profiles ?? {}).filter(([key]) => profiles.has(key)),
            ),
            order: Object.fromEntries(
              Object.entries(auth?.order ?? {}).filter(([provider]) =>
                relevantAuthProvider(provider),
              ),
            ),
          }
        : auth,
      agents: {
        ownership: agents?.ownership,
        defaults: {
          ...agents?.defaults,
          modelPolicy: selection ? undefined : agents?.defaults?.modelPolicy,
        },
        agent: {
          ...resolveAgentEntry({ agents }, agentId),
          modelPolicy: selection ? undefined : resolveAgentEntry({ agents }, agentId)?.modelPolicy,
        },
      },
      channels: {
        defaults: channelConfig?.defaults,
        selected: channels.map((id) => [
          id,
          channelConfig?.[id],
          channelConfig?.modelByChannel?.[id],
        ]),
      },
      activation: resolveChannelConfigActivationFacts({ channels: channelConfig }),
    });
    const relevantPath = (path: string, profiles: ReadonlySet<string>) => {
      const tokens = parseConcreteConfigPathTokens(path);
      if (tokens?.[0] === "logging") {
        return false;
      }
      if (tokens?.[0] === "models" && tokens[1] === "providers" && selection) {
        return typeof tokens[2] !== "string" || relevantAuthProvider(tokens[2]);
      }
      if (tokens?.[0] === "auth" && selection) {
        const key = tokens[2];
        return (
          typeof key !== "string" ||
          (tokens[1] === "profiles"
            ? profiles.has(key)
            : tokens[1] !== "order" || relevantAuthProvider(key))
        );
      }
      return (
        tokens?.[0] !== "channels" ||
        typeof tokens[1] !== "string" ||
        tokens[1] === "defaults" ||
        (tokens[1] === "modelByChannel"
          ? typeof tokens[2] !== "string" || channels.includes(tokens[2])
          : channels.includes(tokens[1]))
      );
    };
    const projectFacts = (value: OpenClawConfig, profiles: ReadonlySet<string>) => {
      const facts = serializeConfigResolutionFacts(value);
      return (
        facts && {
          unresolvedPaths: facts.unresolvedPaths.filter((path) => relevantPath(path, profiles)),
          envSecretRefs: facts.envSecretRefs.filter(([path]) => relevantPath(path, profiles)),
        }
      );
    };
    const pair = (value: OpenClawConfig, profiles: ReadonlySet<string>) => {
      const source = getRuntimeConfigCapture(value)?.source ?? value;
      return {
        runtime: project(value, profiles),
        source: project(source, profiles),
        facts: projectFacts(value, profiles),
        sourceFacts: projectFacts(source, profiles),
      };
    };
    // The config owner supplies immutable publication/source pairs, including in-place
    // republishes. No fingerprint or second mutable config cache belongs to this turn.
    const candidate = captureRuntimeConfig(current);
    return (
      isDeepStrictEqual(
        pair(captured, capturedProfileIds),
        pair(candidate, selection ? profileIds(candidate) : capturedProfileIds),
      ) &&
      sameModelPolicy(captured, candidate) &&
      sameModelPolicy(
        getRuntimeConfigCapture(captured)?.source ?? captured,
        getRuntimeConfigCapture(candidate)?.source ?? candidate,
      )
    );
  };
}
