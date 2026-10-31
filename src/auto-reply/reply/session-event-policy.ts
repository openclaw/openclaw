import { isDeepStrictEqual } from "node:util";
import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import { resolveScheduledToolCallerContext } from "../../agents/scheduled-tool-policy.js";
import { intersectSessionPermissionModes } from "../../agents/session-permission-exec-mode.js";
import { resolveChannelConfigActivationFacts } from "../../config/channel-config-activation.js";
import { serializeConfigResolutionFacts } from "../../config/resolution-facts.js";
import { getRuntimeConfigCapture } from "../../config/runtime-config-capture-state.js";
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

/** Scheduled message actions re-admit their destination policy at each invocation. The
 * turn still owns its creator's channel ceilings and its automatic delivery route. */
export function captureScheduledSessionEventConfigPolicy(
  config: OpenClawConfig,
  agentId: string,
  job: CronStoredJob,
) {
  const captured = captureRuntimeConfig(config);
  const creatorChannel = resolveScheduledToolCallerContext({
    scheduledToolPolicy: resolveCronJobToolPolicyContext(job, resolveCronRunToolsAllow(job)),
  }).channel;
  return (current: OpenClawConfig, routeChannels: Array<string | undefined>) => {
    const channels = [
      ...new Set([creatorChannel, ...routeChannels].filter((id): id is string => Boolean(id))),
    ];
    const project = ({
      agents,
      channels: channelConfig,
      meta: _meta,
      ...global
    }: OpenClawConfig) => ({
      ...global,
      agents: {
        ownership: agents?.ownership,
        defaults: agents?.defaults,
        agent: resolveAgentEntry({ agents }, agentId),
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
    const relevantPath = (path: string) => {
      const tokens = parseConcreteConfigPathTokens(path);
      return (
        tokens?.[0] !== "channels" ||
        typeof tokens[1] !== "string" ||
        tokens[1] === "defaults" ||
        (tokens[1] === "modelByChannel"
          ? typeof tokens[2] !== "string" || channels.includes(tokens[2])
          : channels.includes(tokens[1]))
      );
    };
    const projectFacts = (value: OpenClawConfig) => {
      const facts = serializeConfigResolutionFacts(value);
      return (
        facts && {
          unresolvedPaths: facts.unresolvedPaths.filter(relevantPath),
          envSecretRefs: facts.envSecretRefs.filter(([path]) => relevantPath(path)),
        }
      );
    };
    const pair = (value: OpenClawConfig) => {
      const source = getRuntimeConfigCapture(value)?.source ?? value;
      return {
        runtime: project(value),
        source: project(source),
        facts: projectFacts(value),
        sourceFacts: projectFacts(source),
      };
    };
    // The config owner supplies immutable publication/source pairs, including in-place
    // republishes. No fingerprint or second mutable config cache belongs to this turn.
    return isDeepStrictEqual(pair(captured), pair(captureRuntimeConfig(current)));
  };
}
