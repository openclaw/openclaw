import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  createChannelAdmissionDecisionReceipt,
  type ChannelAdmissionDecisionReceiptInput,
} from "./admission-decision-receipt.js";
import {
  finalizedContextScopeKey,
  INVALID_SCOPE_VALUE,
  ownDataValue,
  publicResultScopeKey,
  scopedParticipantRef,
  snapshotContextBinding,
  normalizeScopeId,
  contextHandoffMatches,
  type ChannelIngressResolutionScope,
} from "./admission-evidence-scope-key.js";
import type { ChannelIngressHostOwner, ChannelParticipantInput } from "./ingress-host-owner.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

export type ChannelAdmissionEvidence = Readonly<{
  kind: "channel-admission-evidence";
}>;

type ChannelAdmissionContribution = Readonly<{
  participant:
    | { state: "present"; rawPrincipalRef: string }
    | { state: "unknown" }
    | { state: "unsupported" };
  decision?: Readonly<{
    participantAware: boolean;
    outcomeAffecting: boolean;
    identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  }>;
}>;

type ChannelAdmissionEvidencePayload =
  | Readonly<{
      kind: "leaf";
      createdAt: number;
      contribution: ChannelAdmissionContribution;
    }>
  | Readonly<{
      kind: "aggregate";
      createdAt: number;
      sources: readonly (ChannelAdmissionEvidence | undefined)[];
    }>;

type ConsumedChannelAdmissionEvidence = Readonly<{
  ingressState: "present" | "unknown" | "unsupported";
  invoker: { state: "present"; kind: "person"; rawPrincipalRef: string } | { state: "unknown" };
  assuranceRef?: string;
  decisionCoverage?: "enforced" | "attribution-only" | "unknown" | "unsupported";
  identifierAuthentication?: "affected" | "evaluated" | "not-evaluated" | "unknown";
}>;

type ChannelIngressResolutionBinding = Readonly<{
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  owner?: ChannelIngressHostOwner;
  gatewayContext?: ReturnType<GatewayContextResolver>;
  scope?: ChannelIngressResolutionScope;
  contextBinding?: Readonly<ChannelIngressContextBinding>;
  publicScopeKey?: string;
  handoff: { consumed: boolean; accepted?: boolean };
}>;

const CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS = 16;
const CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CONTEXT_ADMISSION = Symbol("openclaw.channelContextAdmission");

export class ChannelAdmissionAudit {
  #enabled: boolean;
  #closed = false;
  #revision = {};
  #sink: ((receipt: DecisionReceiptV1) => boolean) | undefined;
  constructor(params: {
    enabled: boolean;
    decisionSink?: (receipt: DecisionReceiptV1) => boolean;
  }) {
    this.#enabled = params.enabled;
    this.#sink = params.decisionSink;
  }
  get enabled(): boolean {
    return this.#enabled;
  }
  configure(enabled: boolean): void {
    if (this.#closed || enabled === this.#enabled) {
      return;
    }
    this.#enabled = enabled;
    this.#revision = {};
  }
  captureCurrent(): () => boolean {
    const revision = this.#revision;
    return () => this.#enabled && this.#revision === revision;
  }
  recordDecision(receipt: DecisionReceiptV1): boolean {
    return this.#enabled ? (this.#sink?.(receipt) ?? false) : false;
  }
  close(): void {
    this.#closed = true;
    this.#enabled = false;
    this.#revision = {};
    this.#sink = undefined;
  }
}

export function createChannelAdmissionAudit(params: {
  enabled: boolean;
  decisionSink?: (receipt: DecisionReceiptV1) => boolean;
}): ChannelAdmissionAudit {
  return new ChannelAdmissionAudit(params);
}

class AdmissionEvidence implements ChannelAdmissionEvidence {
  readonly kind = "channel-admission-evidence";
  #payload: ChannelAdmissionEvidencePayload;
  #audit: ChannelAdmissionAudit | undefined;
  #isCurrent: (() => boolean) | undefined;
  #consumed = false;
  constructor(payload: ChannelAdmissionEvidencePayload, audit: ChannelAdmissionAudit | undefined) {
    this.#payload = payload;
    this.#audit = audit;
    this.#isCurrent = audit?.captureCurrent();
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static read(value: ChannelAdmissionEvidence | undefined) {
    return value !== undefined &&
      value !== null &&
      typeof value === "object" &&
      #payload in value &&
      (value.#isCurrent?.() ?? true)
      ? { payload: value.#payload, audit: value.#audit, consumed: value.#consumed }
      : undefined;
  }
  static consume(value: ChannelAdmissionEvidence): void {
    if (value !== null && typeof value === "object" && #payload in value) {
      value.#consumed = true;
    }
  }
}

class PreparedChannelAdmissionEvidence {
  #consumed = false;
  #evidence: ChannelAdmissionEvidence | undefined;
  #resolver: GatewayContextResolver | undefined;
  #owner: ChannelIngressHostOwner | undefined;
  #gatewayContext: ReturnType<GatewayContextResolver>;
  constructor(
    evidence: ChannelAdmissionEvidence | undefined,
    resolver?: GatewayContextResolver,
    owner?: ChannelIngressHostOwner,
  ) {
    this.#evidence = evidence;
    this.#resolver = resolver;
    this.#owner = owner;
    this.#gatewayContext = owner?.resolveGatewayContext?.();
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static take(value: PreparedChannelAdmissionEvidence) {
    if (!value || typeof value !== "object" || !(#consumed in value) || value.#consumed) {
      return undefined;
    }
    value.#consumed = true;
    const current =
      !value.#owner ||
      (value.#owner.isLive() && value.#owner.resolveGatewayContext?.() === value.#gatewayContext);
    return {
      evidence: current
        ? value.#evidence
        : unknownChannelAdmissionEvidence(AdmissionEvidence.read(value.#evidence)?.audit),
      resolver: current ? value.#resolver : undefined,
    };
  }
}

type ContextAdmissionValue = {
  scope: string | undefined;
  evidence: ChannelAdmissionEvidence | undefined;
  resolver?: GatewayContextResolver;
  resolverConflict?: boolean;
};
class ContextAdmission {
  #context: object;
  #value: Readonly<ContextAdmissionValue>;
  constructor(context: object, value: ContextAdmissionValue) {
    this.#context = context;
    this.#value = Object.freeze(value);
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static read(value: unknown, context: object): Readonly<ContextAdmissionValue> | undefined {
    return value !== null &&
      typeof value === "object" &&
      #context in value &&
      value.#context === context
      ? value.#value
      : undefined;
  }
}
function readContextAdmission(context: object): Readonly<ContextAdmissionValue> | undefined {
  return ContextAdmission.read(ownDataValue(context, CONTEXT_ADMISSION), context);
}
function writeContextAdmission(context: object, value: ContextAdmissionValue): void {
  Object.defineProperty(context, CONTEXT_ADMISSION, {
    value: new ContextAdmission(context, value),
    configurable: true,
  });
}

class HostIngressResolution {
  #binding: ChannelIngressResolutionBinding;
  #participant: ChannelParticipantInput | undefined;
  constructor(binding: ChannelIngressResolutionBinding, participant?: ChannelParticipantInput) {
    this.#binding = binding;
    this.#participant = participant;
    Object.setPrototypeOf(this, null);
  }
  static read(value: object): ChannelIngressResolutionBinding | undefined {
    return value !== null && typeof value === "object" && #binding in value
      ? value.#binding
      : undefined;
  }
  static takeParticipant(value: object): ChannelParticipantInput | undefined {
    if (value === null || typeof value !== "object" || !(#binding in value)) {
      return undefined;
    }
    const participant = value.#binding.handoff.accepted ? value.#participant : undefined;
    value.#participant = undefined;
    return participant;
  }
}
export function takeChannelParticipantInput(
  result: ResolvedChannelMessageIngress,
): ChannelParticipantInput | undefined {
  return HostIngressResolution.takeParticipant(result);
}

function mintChannelAdmissionEvidence(
  audit: ChannelAdmissionAudit | undefined,
  payload:
    | Omit<Extract<ChannelAdmissionEvidencePayload, { kind: "leaf" }>, "createdAt">
    | Omit<Extract<ChannelAdmissionEvidencePayload, { kind: "aggregate" }>, "createdAt">,
): ChannelAdmissionEvidence | undefined {
  if (!audit?.enabled) {
    return undefined;
  }
  return new AdmissionEvidence(Object.freeze({ ...payload, createdAt: Date.now() }), audit);
}
function unsupportedChannelAdmissionEvidence(
  audit: ChannelAdmissionAudit | undefined,
): ChannelAdmissionEvidence | undefined {
  const payload = {
    kind: "leaf" as const,
    contribution: Object.freeze({ participant: { state: "unsupported" as const } }),
  };
  // A capability-absence marker carries no participant facts and needs no ambient collector.
  return audit
    ? mintChannelAdmissionEvidence(audit, payload)
    : new AdmissionEvidence(Object.freeze({ ...payload, createdAt: Date.now() }), undefined);
}

function participantContribution(params: {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
}): ChannelAdmissionContribution {
  const rawPrincipalRef = scopedParticipantRef(params);
  return Object.freeze(
    rawPrincipalRef
      ? { participant: Object.freeze({ state: "present" as const, rawPrincipalRef }) }
      : { participant: Object.freeze({ state: "unknown" as const }) },
  );
}

export function recordChannelIngressResolution(params: {
  result: ResolvedChannelMessageIngress;
  owner?: ChannelIngressHostOwner;
  participantInput?: ChannelParticipantInput;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  scope: ChannelIngressResolutionScope;
}): ResolvedChannelMessageIngress {
  const owner = params.owner;
  if (!owner || owner.channelId !== params.channelId || !owner.isLive()) {
    return params.result;
  }
  const activeOwner = owner;
  const binding = Object.freeze({
    channelId: params.channelId,
    accountId: params.accountId,
    rawPrincipalRef: params.rawPrincipalRef,
    participantOutcomeAffecting: params.participantOutcomeAffecting,
    identifierAuthentication: params.identifierAuthentication,
    owner: activeOwner,
    gatewayContext: activeOwner.resolveGatewayContext?.(),
    scope: Object.freeze({ conversation: Object.freeze({ ...params.scope.conversation }) }),
    contextBinding: snapshotContextBinding(params.scope.contextBinding),
    publicScopeKey: publicResultScopeKey(params.result),
    handoff: { consumed: false },
  });
  return Object.assign(new HostIngressResolution(binding, params.participantInput), params.result);
}

function unknownChannelAdmissionEvidence(
  audit: ChannelAdmissionAudit | undefined,
): ChannelAdmissionEvidence | undefined {
  return mintChannelAdmissionEvidence(audit, {
    kind: "leaf",
    contribution: Object.freeze({ participant: { state: "unknown" as const } }),
  });
}

/** Consume and validate the exact resolver-to-context handoff before context construction. */
export function prepareHostChannelContextAdmissionEvidence(params: {
  owner?: ChannelIngressHostOwner;
  channelId: string;
  accountId?: string;
  ingress?:
    | ResolvedChannelMessageIngress
    | readonly ResolvedChannelMessageIngress[]
    | "unsupported";
  rawPrincipalRef: string | number | null | undefined;
  contextParams: object;
}): PreparedChannelAdmissionEvidence {
  const audit = params.owner?.resolveGatewayContext?.()?.channelAdmissionAudit;
  if (params.ingress === "unsupported") {
    return new PreparedChannelAdmissionEvidence(
      unsupportedChannelAdmissionEvidence(audit),
      undefined,
      params.owner,
    );
  }
  const results =
    params.ingress === undefined
      ? []
      : Array.isArray(params.ingress)
        ? params.ingress
        : [params.ingress as ResolvedChannelMessageIngress];
  const seen = new Set<object>();
  const validBindings: ChannelIngressResolutionBinding[] = [];
  let valid = results.length > 0 && results.length <= CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS;
  for (const [index, result] of results.entries()) {
    const binding = HostIngressResolution.read(result);
    const firstUse = binding !== undefined && !binding.handoff.consumed && !seen.has(result);
    if (binding && !binding.handoff.consumed) {
      // Consume before validation and before the ordinary context builder runs.
      binding.handoff.consumed = true;
    }
    seen.add(result);
    const ownerMatches =
      params.owner !== undefined &&
      binding?.owner === params.owner &&
      binding.gatewayContext === params.owner.resolveGatewayContext?.() &&
      params.owner.isLive();
    const resultIngress = ownDataValue(result, "ingress");
    const resultMatches =
      binding?.publicScopeKey !== undefined &&
      publicResultScopeKey(result) === binding.publicScopeKey &&
      resultIngress !== null &&
      typeof resultIngress === "object" &&
      ownDataValue(resultIngress, "admission") === "dispatch";
    const contextMatches =
      binding !== undefined &&
      contextHandoffMatches({
        ...params,
        binding,
        // A batch exposes the final sender; earlier sources retain their own exact identities.
        rawPrincipalRef:
          index === results.length - 1 ? params.rawPrincipalRef : binding.rawPrincipalRef,
      });
    if (!firstUse || !ownerMatches || !resultMatches || !contextMatches || !binding) {
      valid = false;
    } else {
      validBindings.push(binding);
    }
  }
  const contextMessageId = normalizeScopeId(ownDataValue(params.contextParams, "messageId"));
  const finalMessageId = validBindings.at(-1)?.contextBinding?.messageId;
  if (
    contextMessageId === INVALID_SCOPE_VALUE ||
    (finalMessageId !== undefined && contextMessageId !== finalMessageId)
  ) {
    valid = false;
  }
  if (valid) {
    for (const binding of validBindings) {
      binding.handoff.accepted = true;
    }
  }
  const sources = valid
    ? validBindings.map((binding) => {
        const contribution = participantContribution(binding);
        return mintChannelAdmissionEvidence(audit, {
          kind: "leaf",
          contribution: Object.freeze({
            ...contribution,
            decision: Object.freeze({
              participantAware: contribution.participant.state === "present",
              outcomeAffecting: binding.participantOutcomeAffecting,
              identifierAuthentication: binding.identifierAuthentication,
            }),
          }),
        });
      })
    : [];
  return new PreparedChannelAdmissionEvidence(
    valid ? combineChannelAdmissionEvidence(sources) : unknownChannelAdmissionEvidence(audit),
    valid ? params.owner?.resolveGatewayContext : undefined,
    params.owner,
  );
}

/** Attach one prepared private carrier to the exact finalized context scope. */
export function bindHostChannelContextAdmissionEvidence(params: {
  context: object;
  preparation: PreparedChannelAdmissionEvidence;
}): void {
  const prepared = PreparedChannelAdmissionEvidence.take(params.preparation);
  const scope = finalizedContextScopeKey(params.context);
  const audit = AdmissionEvidence.read(prepared?.evidence)?.audit;
  writeContextAdmission(params.context, {
    scope,
    evidence: scope !== undefined ? prepared?.evidence : unknownChannelAdmissionEvidence(audit),
    resolver: scope !== undefined ? prepared?.resolver : undefined,
  });
}
export function readChannelContextAdmissionEvidence(
  context: object,
): ChannelAdmissionEvidence | undefined {
  return readContextAdmission(context)?.evidence;
}
export function readChannelContextGatewayContextResolver(
  context: object,
): GatewayContextResolver | undefined {
  return readContextAdmission(context)?.resolver;
}

/** Preserve private evidence only when its owner explicitly replaces an unchanged context. */
export function copyChannelParticipantAdmissionEvidence(source: object, target: object): void {
  const original = readContextAdmission(source);
  if (!original) {
    return;
  }
  const targetScope = finalizedContextScopeKey(target);
  const sameScope = original.scope !== undefined && targetScope === original.scope;
  const safeEvidence =
    sameScope && activePayload(original.evidence, Date.now()) !== undefined
      ? original.evidence
      : unknownChannelAdmissionEvidence(AdmissionEvidence.read(original.evidence)?.audit);
  const current = readContextAdmission(target);
  const resolverConflict =
    current?.resolverConflict === true ||
    Boolean(current?.resolver && original.resolver && current.resolver !== original.resolver);
  writeContextAdmission(target, {
    scope: targetScope,
    evidence: safeEvidence,
    resolver: sameScope && !resolverConflict ? original.resolver : undefined,
    resolverConflict,
  });
}

function activePayload(
  evidence: ChannelAdmissionEvidence | undefined,
  now: number,
): ChannelAdmissionEvidencePayload | undefined {
  const stored = AdmissionEvidence.read(evidence);
  if (!stored || stored.consumed) {
    return undefined;
  }
  const { payload, audit } = stored;
  return (!audit || audit.enabled) &&
    now - payload.createdAt <= CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS
    ? payload
    : undefined;
}

/** Preserve one source exactly; collected sources get one new bounded opaque aggregate. */
export function combineChannelAdmissionEvidence(
  evidence: readonly (ChannelAdmissionEvidence | undefined)[],
): ChannelAdmissionEvidence | undefined {
  if (evidence.length === 1) {
    return evidence[0];
  }
  const audit = evidence
    .map((entry) => AdmissionEvidence.read(entry)?.audit)
    .find((entry) => entry !== undefined);
  if (!audit?.enabled) {
    return undefined;
  }
  if (
    evidence.length > CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS ||
    evidence.some((entry) => AdmissionEvidence.read(entry)?.audit !== audit)
  ) {
    return unknownChannelAdmissionEvidence(audit);
  }
  return mintChannelAdmissionEvidence(audit, {
    kind: "aggregate",
    sources: Object.freeze([...evidence]),
  });
}

function inspectContributions(params: {
  evidence: ChannelAdmissionEvidence | undefined;
  now: number;
  seen: Set<object>;
}): ChannelAdmissionContribution[] {
  const payload = activePayload(params.evidence, params.now);
  if (!payload || !params.evidence || params.seen.has(params.evidence)) {
    return [{ participant: { state: "unknown" } }];
  }
  params.seen.add(params.evidence);
  return payload.kind === "leaf"
    ? [payload.contribution]
    : payload.sources.flatMap((source) => inspectContributions({ ...params, evidence: source }));
}

/** Compare opaque participants without exposing or consuming their raw references. */
export function compareChannelAdmissionParticipants(
  evidence: readonly (ChannelAdmissionEvidence | undefined)[],
): "same" | "mixed-or-unknown" {
  const contributions = evidence.flatMap((candidate) =>
    inspectContributions({ evidence: candidate, now: Date.now(), seen: new Set() }),
  );
  if (
    contributions.length === 0 ||
    contributions.length > CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS
  ) {
    return "mixed-or-unknown";
  }
  const participants = contributions.map((item) => item.participant);
  const first = participants[0];
  return first?.state === "present" &&
    participants.every(
      (item) => item.state === "present" && item.rawPrincipalRef === first.rawPrincipalRef,
    )
    ? "same"
    : "mixed-or-unknown";
}

function consumeContributions(params: {
  evidence: ChannelAdmissionEvidence | undefined;
  now: number;
  seen: Set<object>;
}): ChannelAdmissionContribution[] {
  const payload = activePayload(params.evidence, params.now);
  if (!payload || !params.evidence || params.seen.has(params.evidence)) {
    return [{ participant: { state: "unknown" } }];
  }
  params.seen.add(params.evidence);
  AdmissionEvidence.consume(params.evidence);
  if (payload.kind === "leaf") {
    return [payload.contribution];
  }
  const contributions = payload.sources.flatMap((source) =>
    consumeContributions({ ...params, evidence: source }),
  );
  return contributions.length <= CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS
    ? contributions
    : [{ participant: { state: "unknown" } }];
}

function freezeConsumed(
  value: Omit<ConsumedChannelAdmissionEvidence, "invoker"> & {
    invoker: ConsumedChannelAdmissionEvidence["invoker"];
  },
): ConsumedChannelAdmissionEvidence {
  return Object.freeze({
    ...value,
    invoker: Object.freeze(value.invoker),
  });
}

/** Consume one aggregate at run admission. Missing, forged, stale, or reused carriers are unknown. */
export function consumeChannelAdmissionEvidence(
  evidence: ChannelAdmissionEvidence | undefined,
): ConsumedChannelAdmissionEvidence {
  const contributions = consumeContributions({ evidence, now: Date.now(), seen: new Set() });
  const participants = contributions.map((item) => item.participant);
  const allUnsupported =
    participants.length > 0 && participants.every((item) => item.state === "unsupported");
  if (allUnsupported) {
    return freezeConsumed({
      ingressState: "unsupported",
      invoker: { state: "unknown" },
      decisionCoverage: "unsupported",
      identifierAuthentication: "unknown",
    });
  }

  const present = participants.filter(
    (item): item is Extract<(typeof participants)[number], { state: "present" }> =>
      item.state === "present",
  );
  const sameParticipant =
    present.length === participants.length &&
    present.every((item) => item.rawPrincipalRef === present[0]?.rawPrincipalRef);
  if (!sameParticipant || !present[0]) {
    return freezeConsumed({
      ingressState: "unknown",
      invoker: { state: "unknown" },
      decisionCoverage: "unknown",
      identifierAuthentication: "unknown",
    });
  }

  const everyDecisionEnforced = contributions.every(
    (item) => item.decision?.participantAware && item.decision.outcomeAffecting,
  );
  const identifierAuthentication = contributions.some(
    (item) => item.decision?.identifierAuthentication === "affected",
  )
    ? "affected"
    : contributions.some((item) => item.decision?.identifierAuthentication === "evaluated")
      ? "evaluated"
      : contributions.every((item) => item.decision?.identifierAuthentication === "not-evaluated")
        ? "not-evaluated"
        : "unknown";
  return freezeConsumed({
    ingressState: "present",
    invoker: {
      state: "present",
      kind: "person",
      rawPrincipalRef: present[0].rawPrincipalRef,
    },
    assuranceRef: "channel-admission",
    decisionCoverage: everyDecisionEnforced ? "enforced" : "attribution-only",
    identifierAuthentication,
  });
}

/** Queue the channel decision after its exact identity tuple on the shared audit FIFO. */
export function recordChannelAdmissionDecision(
  evidence: ChannelAdmissionEvidence | undefined,
  params: {
    contextId: ChannelAdmissionDecisionReceiptInput["contextId"];
    executionId: ChannelAdmissionDecisionReceiptInput["executionId"];
    runId: ChannelAdmissionDecisionReceiptInput["runId"];
    occurredAt: ChannelAdmissionDecisionReceiptInput["occurredAt"];
    coverageState: ChannelAdmissionDecisionReceiptInput["coverageState"];
    identifierAuthentication: ChannelAdmissionDecisionReceiptInput["identifierAuthentication"];
  },
): boolean {
  const stored = AdmissionEvidence.read(evidence);
  return stored?.audit
    ? stored.audit.recordDecision(createChannelAdmissionDecisionReceipt(params))
    : false;
}
