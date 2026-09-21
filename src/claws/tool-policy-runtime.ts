import { listAgentEntries } from "../agents/agent-scope.js";
import {
  registerRuntimeConfigSnapshotPreparer,
  type RuntimeConfigSnapshotPreparationContext,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import {
  initializeCachedClawInstallSchemaVersions,
  prepareClawInstallSchemaVersions,
  readCachedClawInstallSchemaVersions,
  registerClawInstallSchemaVersionSnapshotListener,
} from "./provenance-runtime-read.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";

const frozenToolAllowPolicies = new WeakSet<object>();
type PreparedClawToolPolicy =
  | { kind: "current" }
  | { kind: "legacy" }
  | { kind: "state-error"; error: unknown };
const preparedClawToolPolicies = new WeakMap<object, PreparedClawToolPolicy>();
type ClawToolPolicyCandidate = { agentId: string; agentConfigDigest: string; tools: object };
let preparedCandidates: ClawToolPolicyCandidate[] = [];
let preparedStateOptions: OpenClawStateDatabaseOptions = {};
const uninitializedStateError = new Error(
  "OpenClaw state database has not initialized Claw consent provenance.",
);

export function markFrozenClawToolAllowPolicy(policy: object | undefined): void {
  if (policy) {
    frozenToolAllowPolicies.add(policy);
  }
}

export function isFrozenClawToolAllowPolicy(policy: object | undefined): boolean {
  return policy ? frozenToolAllowPolicies.has(policy) : false;
}

function applyPreparedClawToolPolicyConsent(): void {
  const snapshot = readCachedClawInstallSchemaVersions(preparedStateOptions);
  for (const candidate of preparedCandidates) {
    if (snapshot.kind === "uninitialized") {
      preparedClawToolPolicies.set(candidate.tools, {
        kind: "state-error",
        error: uninitializedStateError,
      });
      continue;
    }
    if (snapshot.kind === "state-error") {
      if (snapshot.ownershipUnknown || snapshot.knownAgentIds.has(candidate.agentId)) {
        preparedClawToolPolicies.set(candidate.tools, {
          kind: "state-error",
          error: snapshot.error,
        });
      } else {
        preparedClawToolPolicies.delete(candidate.tools);
      }
      continue;
    }
    const schemaVersionRead = snapshot.schemaVersions.get(candidate.agentId);
    if (!schemaVersionRead) {
      preparedClawToolPolicies.delete(candidate.tools);
      continue;
    }
    if (schemaVersionRead.kind === "error") {
      preparedClawToolPolicies.set(candidate.tools, {
        kind: "state-error",
        error: schemaVersionRead.error,
      });
      continue;
    }
    if (
      schemaVersionRead.schemaVersion === CLAW_INSTALL_RECORD_SCHEMA_VERSION &&
      schemaVersionRead.agentConfigDigest !== candidate.agentConfigDigest
    ) {
      preparedClawToolPolicies.set(candidate.tools, {
        kind: "state-error",
        error: new Error("Claw agent configuration does not match its consent provenance."),
      });
      continue;
    }
    preparedClawToolPolicies.set(candidate.tools, {
      kind:
        schemaVersionRead.schemaVersion === CLAW_INSTALL_RECORD_SCHEMA_VERSION
          ? "current"
          : "legacy",
    });
  }
}

function collectClawToolPolicyCandidates(config: OpenClawConfig): ClawToolPolicyCandidate[] {
  return listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    return tools && (tools.profile || tools.allow?.length)
      ? [{ agentId: agent.id, agentConfigDigest: digestClawAgentConfig(agent), tools }]
      : [];
  });
}

function replaceClawToolPolicyCandidates(
  candidates: ClawToolPolicyCandidate[],
  stateOptions: OpenClawStateDatabaseOptions = {},
): void {
  for (const candidate of preparedCandidates) {
    preparedClawToolPolicies.delete(candidate.tools);
  }
  preparedCandidates = candidates;
  preparedStateOptions = stateOptions;
}

function prepareClawToolPolicyConsent(config: OpenClawConfig): void {
  replaceClawToolPolicyCandidates(collectClawToolPolicyCandidates(config));
  initializeCachedClawInstallSchemaVersions({
    ...preparedStateOptions,
    artifactPreservingReadOnly: false,
  });
  applyPreparedClawToolPolicyConsent();
}

async function prepareClawToolPolicyConsentAsync(
  config: OpenClawConfig,
  context: RuntimeConfigSnapshotPreparationContext,
): Promise<() => void> {
  const preparedSchemaVersions = await prepareClawInstallSchemaVersions({
    env: context.env,
    artifactPreservingReadOnly: false,
  });
  return () => {
    replaceClawToolPolicyCandidates(collectClawToolPolicyCandidates(config), {
      path: preparedSchemaVersions.path,
    });
    preparedSchemaVersions.publish();
    applyPreparedClawToolPolicyConsent();
  };
}

registerClawInstallSchemaVersionSnapshotListener(() => applyPreparedClawToolPolicyConsent());
registerRuntimeConfigSnapshotPreparer(prepareClawToolPolicyConsent, {
  prepareAsync: prepareClawToolPolicyConsentAsync,
});

class ClawToolProfileConsentError extends Error {
  constructor(agentId: string, options: { unboundedFullProfile?: boolean } = {}) {
    super(
      options.unboundedFullProfile
        ? `Claw-managed agent ${JSON.stringify(agentId)} uses the legacy unbounded full tool profile. ` +
            "Add an explicit tools.allow list to its package OpenClaw profile, then " +
            `run \`openclaw claws update ${agentId}\` and approve the refreshed tool authority.`
        : `Claw-managed agent ${JSON.stringify(agentId)} uses a legacy dynamic tool policy. ` +
            `Run \`openclaw claws update ${agentId}\` and approve the refreshed tool authority before running it.`,
    );
    this.name = "ClawToolProfileConsentError";
  }
}

class ClawToolProfileConsentStateError extends Error {
  constructor(agentId: string, cause: unknown) {
    super(
      `Cannot verify the installed tool authority for Claw-managed agent ${JSON.stringify(agentId)}. ` +
        "Repair the OpenClaw state database before running it.",
      { cause },
    );
    this.name = "ClawToolProfileConsentStateError";
  }
}

export function resolveClawToolPolicyConsent(params: {
  agentTools?: object;
  agentId?: string;
  hasAgentAllowlist: boolean;
  ownsProfile: boolean;
  profile?: string;
}): { frozen: boolean } {
  if (!params.agentId || (!params.ownsProfile && !params.hasAgentAllowlist)) {
    return { frozen: false };
  }
  const prepared = params.agentTools ? preparedClawToolPolicies.get(params.agentTools) : undefined;
  if (!prepared) {
    return { frozen: false };
  }
  if (prepared.kind === "state-error") {
    throw new ClawToolProfileConsentStateError(params.agentId, prepared.error);
  }
  if (
    prepared.kind === "legacy" ||
    (params.ownsProfile && (params.profile !== "full" || !params.hasAgentAllowlist))
  ) {
    throw new ClawToolProfileConsentError(params.agentId, {
      unboundedFullProfile:
        prepared.kind === "legacy" && params.profile === "full" && !params.hasAgentAllowlist,
    });
  }
  return { frozen: params.hasAgentAllowlist };
}
