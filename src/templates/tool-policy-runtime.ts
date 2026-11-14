import {
  registerRuntimeConfigSnapshotPreparer,
  type RuntimeConfigSnapshotPreparationContext,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION } from "./provenance-agent-origin.js";
import {
  templateSchemaVersionNotifications,
  prepareTemplateInstallSchemaVersions,
  readCachedTemplateInstallSchemaVersions,
} from "./provenance-runtime-read.js";
import { TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";
import {
  collectTemplateToolPolicyCandidates,
  type TemplateToolPolicyCandidate,
} from "./tool-policy-candidates.js";

const frozenToolAllowPolicies = new WeakSet<object>();
type PreparedTemplateToolPolicy =
  | { kind: "current" }
  | { kind: "legacy" }
  | { kind: "changed" }
  | { kind: "state-error"; error: unknown };
const preparedTemplateToolPolicies = new WeakMap<object, PreparedTemplateToolPolicy>();
let preparedCandidates: TemplateToolPolicyCandidate[] = [];
let preparedStateOptions: OpenClawStateDatabaseOptions = {};

export function markFrozenTemplateToolAllowPolicy(policy: object | undefined): void {
  if (policy) {
    frozenToolAllowPolicies.add(policy);
  }
}

export function isFrozenTemplateToolAllowPolicy(policy: object | undefined): boolean {
  return policy ? frozenToolAllowPolicies.has(policy) : false;
}

function applyPreparedTemplateToolPolicyConsent(
  candidates: readonly TemplateToolPolicyCandidate[] = preparedCandidates,
  stateOptions: OpenClawStateDatabaseOptions = preparedStateOptions,
): void {
  const snapshot = readCachedTemplateInstallSchemaVersions(stateOptions);
  for (const candidate of candidates) {
    if (snapshot.kind === "uninitialized") {
      preparedTemplateToolPolicies.set(candidate.tools, {
        kind: "state-error",
        error: new Error(
          "OpenClaw state database has not initialized Template consent provenance.",
        ),
      });
      continue;
    }
    if (snapshot.kind === "state-error") {
      if (snapshot.ownershipUnknown || snapshot.knownAgentIds.has(candidate.agentId)) {
        preparedTemplateToolPolicies.set(candidate.tools, {
          kind: "state-error",
          error: snapshot.error,
        });
      } else {
        preparedTemplateToolPolicies.delete(candidate.tools);
      }
      continue;
    }
    const schemaVersionRead = snapshot.schemaVersions.get(candidate.agentId);
    if (!schemaVersionRead) {
      preparedTemplateToolPolicies.delete(candidate.tools);
      continue;
    }
    if (schemaVersionRead.kind === "error") {
      preparedTemplateToolPolicies.set(candidate.tools, {
        kind: "state-error",
        error: schemaVersionRead.error,
      });
      continue;
    }
    let consent: TemplateConsentMatch;
    try {
      consent = matchTemplateConsent(candidate, schemaVersionRead, stateOptions.env);
    } catch (error) {
      preparedTemplateToolPolicies.set(candidate.tools, {
        kind: "state-error",
        error,
      });
      continue;
    }
    preparedTemplateToolPolicies.set(candidate.tools, { kind: consent });
  }
}

type TemplateConsentMatch = "current" | "legacy" | "changed";

/** Compare live agent config with the digest its legacy install record consented to. */
export function matchTemplateConsent(
  candidate: TemplateToolPolicyCandidate,
  record: { schemaVersion: string; agentConfigDigest: string },
  env?: NodeJS.ProcessEnv,
): TemplateConsentMatch {
  const adopted = record.schemaVersion === TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION;
  if (!adopted && record.schemaVersion !== TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION) {
    return "legacy";
  }
  const accepted = adopted
    ? candidate.adoptedAgentConfigDigests(env)
    : { owned: candidate.agentConfigDigest, legacy: candidate.legacyAgentConfigDigest };
  return record.agentConfigDigest === accepted.owned || record.agentConfigDigest === accepted.legacy
    ? "current"
    : "changed";
}

/** Bind a captured construction config to the owner's prepared provenance facts. */
export function prepareCapturedTemplateToolPolicyConsent(
  config: OpenClawConfig,
  stateOptions: OpenClawStateDatabaseOptions,
): void {
  applyPreparedTemplateToolPolicyConsent(collectTemplateToolPolicyCandidates(config), stateOptions);
}

function replaceTemplateToolPolicyCandidates(
  candidates: TemplateToolPolicyCandidate[],
  stateOptions: OpenClawStateDatabaseOptions = {},
): void {
  for (const candidate of preparedCandidates) {
    preparedTemplateToolPolicies.delete(candidate.tools);
  }
  preparedCandidates = candidates;
  preparedStateOptions = stateOptions;
}

function prepareTemplateToolPolicyConsent(config: OpenClawConfig): void {
  replaceTemplateToolPolicyCandidates(collectTemplateToolPolicyCandidates(config));
  applyPreparedTemplateToolPolicyConsent();
}

async function prepareTemplateToolPolicyConsentAsync(
  config: OpenClawConfig,
  context: RuntimeConfigSnapshotPreparationContext,
): Promise<() => void> {
  const preparedSchemaVersions = await prepareTemplateInstallSchemaVersions({
    env: context.env,
    artifactPreservingReadOnly: false,
  });
  return () => {
    replaceTemplateToolPolicyCandidates(collectTemplateToolPolicyCandidates(config), {
      path: preparedSchemaVersions.path,
      env: context.env,
    });
    preparedSchemaVersions.publish();
    applyPreparedTemplateToolPolicyConsent();
  };
}

templateSchemaVersionNotifications.onChanged = () => applyPreparedTemplateToolPolicyConsent();
registerRuntimeConfigSnapshotPreparer(prepareTemplateToolPolicyConsent, {
  prepareAsync: prepareTemplateToolPolicyConsentAsync,
});

class TemplateToolProfileConsentError extends Error {
  constructor(agentId: string, reason: "changed" | "unbounded-full-profile" | "dynamic-policy") {
    const subject = `Template-managed agent ${JSON.stringify(agentId)}`;
    const release =
      `stop the Gateway and run \`openclaw templates release ${agentId}\` to review its tool ` +
      "authority and keep it as an ordinary agent.";
    super(
      reason === "changed"
        ? `${subject} was edited after its Template consent was recorded, so it will not run ` +
            `with the changed settings. Undo the change, or ${release}`
        : `${subject} uses ${
            reason === "unbounded-full-profile"
              ? "the legacy unbounded full tool profile"
              : "a legacy dynamic tool policy"
          }, which its Template consent cannot refresh. To keep it, ${release}`,
    );
    this.name = "TemplateToolProfileConsentError";
  }
}

class TemplateToolProfileConsentStateError extends Error {
  constructor(agentId: string, cause: unknown) {
    super(
      `Cannot verify the installed tool authority for Template-managed agent ${JSON.stringify(agentId)}. ` +
        "Repair the OpenClaw state database before running it.",
      { cause },
    );
    this.name = "TemplateToolProfileConsentStateError";
  }
}

export function resolveTemplateToolPolicyConsent(params: {
  agentTools?: object;
  agentId?: string;
  hasAgentAllowlist: boolean;
  ownsProfile: boolean;
  profile?: string;
}): { frozen: boolean } {
  if (!params.agentId || (!params.ownsProfile && !params.hasAgentAllowlist)) {
    return { frozen: false };
  }
  const prepared = params.agentTools
    ? preparedTemplateToolPolicies.get(params.agentTools)
    : undefined;
  if (!prepared) {
    return { frozen: false };
  }
  if (prepared.kind === "state-error") {
    throw new TemplateToolProfileConsentStateError(params.agentId, prepared.error);
  }
  if (prepared.kind === "changed") {
    throw new TemplateToolProfileConsentError(params.agentId, "changed");
  }
  if (
    prepared.kind === "legacy" ||
    (params.ownsProfile && (params.profile !== "full" || !params.hasAgentAllowlist))
  ) {
    throw new TemplateToolProfileConsentError(
      params.agentId,
      prepared.kind === "legacy" && params.profile === "full" && !params.hasAgentAllowlist
        ? "unbounded-full-profile"
        : "dynamic-policy",
    );
  }
  return { frozen: params.hasAgentAllowlist };
}
