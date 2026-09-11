import {
  readSkillProposalRevisionChangedError,
  type SkillsProposalApplyResult,
  type SkillsProposalRecordResult,
} from "@openclaw/gateway-protocol";
import type { SkillWorkshopRevisionAdmissionOutcome } from "../../app/skill-workshop-revision-admissions.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type {
  SkillWorkshopAction,
  SkillWorkshopProposal,
  SkillWorkshopProposalDecision,
} from "../../lib/skill-workshop/index.ts";
import {
  proposalFromActionRecord,
  proposalFromEvaluation,
  type SkillProposalEvaluateResult,
} from "./proposal-records.ts";
import {
  invalidateSkillWorkshopReads,
  loadedSkillWorkshopAgentParams,
  loadSkillWorkshopProposalDetail,
  loadSkillWorkshopProposals,
  mergeProposal,
  resolveSkillWorkshopAgentId,
  type SkillWorkshopContext,
  type SkillWorkshopLoadOptions,
} from "./proposals.ts";
import type { SkillWorkshopState } from "./state.ts";

const SKILL_WORKSHOP_NOTICE_MS = 2800;

function clearActionNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}

function showActionNotice(
  state: SkillWorkshopState,
  proposal: SkillWorkshopProposal | undefined,
  label: string,
  options?: { persistent?: boolean },
): void {
  if (!proposal) {
    return;
  }
  clearActionNoticeTimer(state);
  state.skillWorkshopActionNotice = {
    key: proposal.key,
    label,
    slug: proposal.slug || proposal.name,
  };
  if (options?.persistent) {
    return;
  }
  state.skillWorkshopActionNoticeTimer = globalThis.setTimeout(() => {
    if (state.skillWorkshopActionNotice?.key === proposal.key) {
      state.skillWorkshopActionNotice = null;
    }
    state.skillWorkshopActionNoticeTimer = null;
  }, SKILL_WORKSHOP_NOTICE_MS);
}

async function refreshAfterMutation(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  options?: SkillWorkshopLoadOptions,
): Promise<void> {
  if (options?.isCurrent?.() === false) {
    return;
  }
  state.skillWorkshopLoaded = false;
  await loadSkillWorkshopProposals(state, context, { ...options, force: true });
  if (options?.isCurrent?.() === false) {
    return;
  }
  if (
    state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId)?.status ===
    "pending"
  ) {
    await loadSkillWorkshopProposalDetail(state, context, proposalId, { ...options, force: true });
  }
}

function markSkillWorkshopRevisionChanged(
  state: SkillWorkshopState,
  proposalId: string,
  fallback?: SkillWorkshopProposal,
): void {
  showActionNotice(
    state,
    state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId) ?? fallback,
    t("skillWorkshop.notices.proposalChanged"),
    { persistent: true },
  );
}

export async function runSkillWorkshopLifecycleAction(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  action: Extract<SkillWorkshopAction, "apply" | "reject">,
  decision: SkillWorkshopProposalDecision,
  options?: Pick<SkillWorkshopLoadOptions, "isCurrent" | "onProgress">,
): Promise<void> {
  const { proposalId, expectedRevisionHash } = decision;
  const method = action === "apply" ? "skills.proposals.apply" : "skills.proposals.reject";
  if (!canCallGatewayMethod(context.gateway.snapshot, method, "operator.admin")) {
    return;
  }
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || state.skillWorkshopActionBusy) {
    return;
  }
  const requestAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  const isCurrentAction = () =>
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    resolveSkillWorkshopAgentId(context) === requestAgentId;
  if (!isCurrentAction()) {
    return;
  }
  const previous = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (action === "apply" && previous?.degradedState) {
    state.skillWorkshopError = t("skillWorkshop.detail.draftMissing");
    return;
  }
  if (!expectedRevisionHash) {
    clearActionNoticeTimer(state);
    state.skillWorkshopActionNotice = null;
    state.skillWorkshopError = t("skillWorkshop.evaluation.errors.revisionHashUnavailable");
    return;
  }
  const busy = { key: proposalId, action };
  state.skillWorkshopActionBusy = busy;
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  state.skillWorkshopAgentId ??= requestAgentId;
  const refreshOptions = { isCurrent: isCurrentAction, onProgress: options?.onProgress };
  try {
    const requestParams = { agentId: requestAgentId, proposalId, expectedRevisionHash };
    const record =
      action === "apply"
        ? (await client.request<SkillsProposalApplyResult>(method, requestParams))?.record
        : await client.request<SkillsProposalRecordResult>(method, requestParams);
    if (!isCurrentAction()) {
      return;
    }
    if (
      !record ||
      record.id !== proposalId ||
      record.status !== (action === "apply" ? "applied" : "rejected")
    ) {
      state.skillWorkshopError = t("skillWorkshop.notices.confirmUnconfirmed");
      return;
    }
    invalidateSkillWorkshopReads(state);
    const confirmed = proposalFromActionRecord(record, previous);
    mergeProposal(state, confirmed);
    showActionNotice(
      state,
      confirmed,
      t(action === "apply" ? "skillWorkshop.notices.applied" : "skillWorkshop.notices.rejected"),
    );
    options?.onProgress?.();
    await refreshAfterMutation(state, context, proposalId, refreshOptions);
  } catch (err) {
    if (!isCurrentAction()) {
      return;
    }
    if (readSkillProposalRevisionChangedError(err)) {
      invalidateSkillWorkshopReads(state);
      await refreshAfterMutation(state, context, proposalId, refreshOptions);
      if (isCurrentAction()) {
        markSkillWorkshopRevisionChanged(state, proposalId, previous);
      }
    } else {
      state.skillWorkshopError = formatUiError(err);
    }
  } finally {
    if (state.skillWorkshopActionBusy === busy) {
      state.skillWorkshopActionBusy = null;
    }
  }
}

export async function runSkillWorkshopEvaluation(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (
    !canCallGatewayMethod(context.gateway.snapshot, "skills.proposals.evaluate", "operator.admin")
  ) {
    return false;
  }
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || state.skillWorkshopActionBusy) {
    return false;
  }
  const previous = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (!previous || previous.status !== "pending") {
    return false;
  }
  const requestAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = requestAgentId;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action: "evaluate" };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    const loaded = await loadSkillWorkshopProposalDetail(state, context, proposalId, {
      force: true,
    });
    if (
      !loaded ||
      !isCurrent() ||
      state.skillWorkshopAgentId !== requestAgentId ||
      !canCallGatewayMethod(context.gateway.snapshot, "skills.proposals.evaluate", "operator.admin")
    ) {
      return false;
    }
    const current = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
    if (current?.degradedState) {
      throw new Error(t("skillWorkshop.detail.draftMissing"));
    }
    if (!current || current.status !== "pending" || !current.revisionHash) {
      throw new Error(t("skillWorkshop.evaluation.errors.revisionHashUnavailable"));
    }
    const result = await client.request<SkillProposalEvaluateResult>("skills.proposals.evaluate", {
      agentId: requestAgentId,
      proposalId,
      expectedRevisionHash: current.revisionHash,
    });
    if (!isCurrent() || state.skillWorkshopAgentId !== requestAgentId) {
      return false;
    }
    if (result.evaluation.revisionHash !== current.revisionHash) {
      throw new Error(t("skillWorkshop.evaluation.errors.revisionChanged"));
    }
    mergeProposal(state, proposalFromEvaluation(result, current));
    await loadSkillWorkshopProposalDetail(state, context, proposalId, { force: true });
    showActionNotice(
      state,
      state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId) ?? previous,
      t("skillWorkshop.actions.evaluated"),
    );
    return true;
  } catch (err) {
    if (state.skillWorkshopAgentId === requestAgentId) {
      state.skillWorkshopError = formatUiError(err);
    }
    return false;
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === "evaluate"
    ) {
      state.skillWorkshopActionBusy = null;
    }
  }
}

export async function requestSkillWorkshopRevision(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  sendRevisionRequest: (
    instructions: string,
    proposal: SkillWorkshopProposal,
    agentId: string,
    expectedRevisionHash?: string,
  ) => Promise<SkillWorkshopRevisionAdmissionOutcome>,
  isCurrent: () => boolean = () => true,
): Promise<SkillWorkshopRevisionAdmissionOutcome | null> {
  if (
    !canCallGatewayMethod(
      context.gateway.snapshot,
      "skills.proposals.requestRevision",
      "operator.admin",
    )
  ) {
    return null;
  }
  if (state.skillWorkshopActionBusy) {
    return null;
  }
  const proposal = state.skillWorkshopProposals.find((item) => item.key === proposalId);
  const instructions = state.skillWorkshopRevisionDraft.trim();
  if (!proposal || !instructions) {
    return null;
  }
  if (proposal.degradedState) {
    state.skillWorkshopError = t("skillWorkshop.detail.draftMissing");
    return null;
  }
  const proposalAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = proposalAgentId;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action: "revise" };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    if (
      !isCurrent() ||
      state.skillWorkshopAgentId !== proposalAgentId ||
      !canCallGatewayMethod(
        context.gateway.snapshot,
        "skills.proposals.requestRevision",
        "operator.admin",
      )
    ) {
      return null;
    }
    const currentProposal =
      state.skillWorkshopProposals.find((item) => item.key === proposalId) ?? proposal;
    const outcome = await sendRevisionRequest(
      instructions,
      currentProposal,
      proposalAgentId,
      currentProposal.revisionHash ?? undefined,
    );
    if (outcome.status === "revision-changed") {
      if (isCurrent() && state.skillWorkshopAgentId === proposalAgentId) {
        await refreshAfterMutation(state, context, proposalId);
        state.skillWorkshopRevisionKey = null;
        state.skillWorkshopRevisionDraft = "";
        markSkillWorkshopRevisionChanged(state, proposalId, proposal);
      }
      return outcome;
    }
    if (outcome.status === "retryable-failed") {
      if (isCurrent() && state.skillWorkshopAgentId === proposalAgentId) {
        state.skillWorkshopError = t("skillWorkshop.revision.notAdmitted", {
          error: outcome.error,
        });
      }
      return outcome;
    }
    if (!isCurrent() || state.skillWorkshopAgentId !== proposalAgentId) {
      return outcome;
    }
    state.skillWorkshopRevisionKey = null;
    state.skillWorkshopRevisionDraft = "";
    showActionNotice(state, proposal, t("skillWorkshop.notices.revisionRequested"));
    return outcome;
  } catch (err) {
    if (isCurrent()) {
      state.skillWorkshopError = t("skillWorkshop.revision.notAdmitted", {
        error: formatUiError(err),
      });
    }
    return null;
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === "revise"
    ) {
      state.skillWorkshopActionBusy = null;
    }
  }
}
