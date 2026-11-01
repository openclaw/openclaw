/** Collects agent-scoped sandbox SSH SecretRefs during runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveSandboxScope } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { runtimeSandboxSecretOwnerId } from "./runtime-sandbox-secret-owner.js";
import {
  createConfigSecretInputCollector,
  type ResolverContext,
  type SecretAssignmentOwner,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

const SANDBOX_SSH_SECRET_KEYS = ["identityData", "certificateData", "knownHostsData"] as const;

type SandboxSshSecretKey = (typeof SANDBOX_SSH_SECRET_KEYS)[number];

function sandboxSecretOwner(agentId: string, contract: unknown): SecretAssignmentOwner {
  return {
    ownerKind: "capability",
    ownerId: runtimeSandboxSecretOwnerId(agentId),
    requiredForGateway: false,
    disposition: "isolate",
    contract,
  };
}

/** Collects SSH material once for every agent whose current backend can manage it. */
export function collectAgentSandboxAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  agentId?: string;
}): void {
  const collect = createConfigSecretInputCollector(params);
  const rawAgents: unknown = params.config.agents;
  const agents = isRecord(rawAgents) ? rawAgents : undefined;
  if (!agents) {
    return;
  }
  const defaultsAgent = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsSandbox = isRecord(defaultsAgent?.sandbox) ? defaultsAgent.sandbox : undefined;
  const defaultsSsh = isRecord(defaultsSandbox?.ssh) ? defaultsSandbox.ssh : undefined;
  const defaultsBackend = normalizeOptionalLowercaseString(defaultsSandbox?.backend) ?? "docker";
  const activeDefaultKeys = new Set<SandboxSshSecretKey>();
  const seenAgentIds = new Set<string>();

  for (const { entry: rawAgent, source } of listAgentEntriesWithSource(params.config)) {
    const rawAgentRecord: unknown = rawAgent;
    if (!isRecord(rawAgentRecord)) {
      continue;
    }
    const agentId = normalizeAgentId(rawAgent.id);
    if (seenAgentIds.has(agentId)) {
      continue;
    }
    seenAgentIds.add(agentId);
    const agentPath =
      source.kind === "entries"
        ? appendConfigPathSegment("agents.entries", source.key)
        : `agents.list[${source.index}]`;

    const sandbox = isRecord(rawAgentRecord.sandbox) ? rawAgentRecord.sandbox : undefined;
    const ssh = isRecord(sandbox?.ssh) ? sandbox.ssh : undefined;
    const backend = normalizeOptionalLowercaseString(sandbox?.backend) ?? defaultsBackend;
    const scope = resolveSandboxScope({
      scope:
        typeof sandbox?.scope === "string"
          ? (sandbox.scope as "agent" | "session" | "shared")
          : typeof defaultsSandbox?.scope === "string"
            ? (defaultsSandbox.scope as "agent" | "session" | "shared")
            : undefined,
    });
    // Existing registry entries remain inspectable/removable after an agent or its
    // sandbox is disabled, so SSH lifecycle credentials stay materialized while
    // SSH remains the configured backend.
    const active = backend === "ssh";
    const owner = sandboxSecretOwner(agentId, {
      defaults: defaultsSandbox,
      override: sandbox,
      agentEnabled: rawAgentRecord["enabled"],
    });

    for (const key of SANDBOX_SSH_SECRET_KEYS) {
      const hasAgentOverride = Boolean(ssh && Object.hasOwn(ssh, key));
      if (hasAgentOverride && ssh) {
        collect(ssh, key, `${agentPath}.sandbox.ssh.${key}`, {
          active: scope !== "shared" && active,
          inactiveReason:
            scope === "shared"
              ? "shared sandbox scope ignores agent SSH overrides."
              : "sandbox SSH backend is not configured for this agent.",
          owner,
        });
        if (scope !== "shared") {
          continue;
        }
      }

      if (!defaultsSsh || !Object.hasOwn(defaultsSsh, key)) {
        continue;
      }
      if (!active) {
        continue;
      }
      activeDefaultKeys.add(key);
      collect(defaultsSsh, key, `agents.defaults.sandbox.ssh.${key}`, {
        active: true,
        inactiveReason: "sandbox SSH backend is not configured for this agent.",
        owner,
      });
    }
  }

  if (!defaultsSsh) {
    return;
  }
  for (const key of SANDBOX_SSH_SECRET_KEYS) {
    if (!Object.hasOwn(defaultsSsh, key) || activeDefaultKeys.has(key)) {
      continue;
    }
    // Unlisted agents and stale registry entries still resolve through defaults,
    // even when every current list entry overrides this credential.
    const active = defaultsBackend === "ssh";
    const fallbackAgentId =
      params.agentId === undefined
        ? resolveDefaultAgentId(params.config)
        : normalizeAgentId(params.agentId);
    collect(defaultsSsh, key, `agents.defaults.sandbox.ssh.${key}`, {
      active,
      inactiveReason: "no enabled agent uses the sandbox SSH material.",
      owner: sandboxSecretOwner(fallbackAgentId, {
        defaults: defaultsSandbox,
      }),
    });
  }
}
