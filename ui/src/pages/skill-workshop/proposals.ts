import { stripFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationGateway } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { compareSkillWorkshopInstructions } from "../../lib/skill-workshop/diff-worker.ts";
import {
  filterSkillWorkshopProposals,
  changedSkillWorkshopVersion,
  type SkillWorkshopInstalledSkill,
  type SkillWorkshopInstalledSelection,
  type SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";
import {
  parseDateMs,
  proposalFromInspect,
  proposalFromManifest,
  type SkillProposalInspectResult,
  type SkillProposalManifest,
} from "./proposal-records.ts";
import type { SkillWorkshopState } from "./state.ts";
export {
  createSkillWorkshopState,
  skillWorkshopRouteData,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./state.ts";

export type SkillWorkshopLoadOptions = {
  force?: boolean;
  onProgress?: () => void;
  isCurrent?: () => boolean;
};

const readGenerationByState = new WeakMap<SkillWorkshopState, number>();

function readGeneration(state: SkillWorkshopState): number {
  return readGenerationByState.get(state) ?? 0;
}

// A confirmed mutation retires reads that could still contain the previous draft.
export function invalidateSkillWorkshopReads(state: SkillWorkshopState): void {
  readGenerationByState.set(state, readGeneration(state) + 1);
  state.skillWorkshopLoaded = false;
  state.skillWorkshopLoading = false;
  state.skillWorkshopInspectingKey = null;
  inspectRequestsByState.delete(state);
}

export type SkillWorkshopContext = {
  gateway: Pick<ApplicationGateway, "snapshot">;
  agentSelection: Pick<AgentSelectionCapability, "state">;
};

function skillWorkshopAgentParams(context: SkillWorkshopContext): { agentId: string } {
  const snapshot = context.gateway.snapshot;
  const sessionAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId;
  const selectedAgentId = context.agentSelection.state.selectedId;
  return {
    agentId: selectedAgentId
      ? normalizeAgentId(selectedAgentId)
      : sessionAgentId
        ? normalizeAgentId(sessionAgentId)
        : resolveUiSelectedGlobalAgentId(snapshot),
  };
}

export function resolveSkillWorkshopAgentId(context: SkillWorkshopContext): string {
  return skillWorkshopAgentParams(context).agentId;
}

export function loadedSkillWorkshopAgentParams(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
): { agentId: string } {
  return {
    agentId: state.skillWorkshopAgentId ?? skillWorkshopAgentParams(context).agentId,
  };
}

function resetSkillWorkshopAgentScope(state: SkillWorkshopState, agentId: string): void {
  invalidateSkillWorkshopReads(state);
  state.skillWorkshopAgentId = agentId;
  state.skillWorkshopProposals = [];
  state.skillWorkshopInstalledSkills = [];
  state.skillWorkshopInstalledName = null;
  state.skillWorkshopSelectedKey = null;
  state.skillWorkshopInspectingKey = null;
  state.skillWorkshopRevisionKey = null;
  state.skillWorkshopRevisionDraft = "";
  state.skillWorkshopFilePreviewKey = null;
  state.skillWorkshopFilePreviewQuery = "";
  selectionRequestByState.delete(state);
}

export function mergeProposal(state: SkillWorkshopState, proposal: SkillWorkshopProposal): void {
  const proposals = state.skillWorkshopProposals;
  const index = proposals.findIndex((item) => item.key === proposal.key);
  if (index < 0) {
    state.skillWorkshopProposals = [proposal, ...proposals];
    return;
  }
  state.skillWorkshopProposals = [
    ...proposals.slice(0, index),
    proposal,
    ...proposals.slice(index + 1),
  ];
}

export async function selectSkillWorkshopInstalledSkill(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  name: string,
  options?: SkillWorkshopLoadOptions,
): Promise<void> {
  const skill = state.skillWorkshopInstalledSkills.find((entry) => entry.name === name);
  if (!skill) {
    return;
  }
  state.skillWorkshopInstalledName = name;
  await loadInstalledSkill(state, context, skill, options);
}

async function loadInstalledSkill(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  skill: SkillWorkshopInstalledSkill,
  options?: SkillWorkshopLoadOptions,
): Promise<void> {
  const { client, phase } = context.gateway.snapshot;
  const agentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (
    !client ||
    phase !== "connected" ||
    (skill.read && !options?.force) ||
    options?.isCurrent?.() === false
  ) {
    return;
  }
  // Each inventory row owns its read. Replacing inventory or retrying revokes old results.
  const loading: Extract<SkillWorkshopInstalledSelection, { status: "loading" }> = {
    status: "loading",
    name: skill.name,
  };
  skill.read = loading;
  const isCurrentRead = () =>
    options?.isCurrent?.() !== false &&
    state.skillWorkshopInstalledSkills.includes(skill) &&
    skill.read === loading &&
    state.skillWorkshopAgentId === agentId &&
    skillWorkshopAgentParams(context).agentId === agentId &&
    context.gateway.snapshot.client === client;
  const read = await readSkillWorkshopInstalledSkill(
    client,
    agentId,
    skill.name,
    state.skillWorkshopProposals,
    (content) => {
      if (isCurrentRead()) {
        loading.content = content;
        options?.onProgress?.();
      }
    },
  );
  if (isCurrentRead()) {
    skill.read = read;
  }
}

async function readSkillWorkshopInstalledSkill(
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>,
  agentId: string,
  name: string,
  proposals: SkillWorkshopProposal[],
  onContent: (content: string) => void,
): Promise<SkillWorkshopInstalledSelection> {
  try {
    const result = await client.request<SkillWorkshopInstalledSkill & { content: string }>(
      "skills.workshop.read",
      { agentId, name },
    );
    onContent(result.content);
    const saved = await Promise.allSettled(
      proposals
        .filter((proposal) => proposal.status === "applied" && proposal.slug === result.skillKey)
        .map(async (proposal) => {
          const { record, content } = await client.request<SkillProposalInspectResult>(
            "skills.proposals.inspect",
            {
              agentId,
              proposalId: proposal.key,
            },
          );
          // Same-named workspace proposals are not versions of this agent's installed skill.
          return record.status === "applied" &&
            record.target.source === "openclaw-workshop" &&
            record.target.skillKey === result.skillKey &&
            (record.kind === "create" ? record.target.skillKey : record.target.skillName) ===
              result.name
            ? {
                key: record.id,
                appliedAt: record.appliedAt,
                // Draft lifecycle headers are not skill instructions.
                diff: await compareSkillWorkshopInstructions(
                  stripFrontmatterBlock(content),
                  stripFrontmatterBlock(result.content),
                ),
              }
            : null;
        }),
    );
    let savedVersionsError: string | undefined;
    const savedVersions = saved
      .flatMap((read) => {
        if (read.status === "rejected") {
          savedVersionsError = formatUiError(read.reason);
          return [];
        }
        return read.value ? [read.value] : [];
      })
      .toSorted((left, right) => (right.appliedAt ?? "").localeCompare(left.appliedAt ?? ""));
    return {
      status: "ready",
      name,
      content: result.content,
      savedVersions,
      savedVersionsError,
    };
  } catch (error) {
    return {
      status: "error",
      name,
      error: formatUiError(error),
    };
  }
}

export async function loadSkillWorkshopProposals(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: SkillWorkshopLoadOptions,
): Promise<void> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || options?.isCurrent?.() === false) {
    return;
  }
  const requestAgentId = skillWorkshopAgentParams(context).agentId;
  if (state.skillWorkshopAgentId !== requestAgentId) {
    resetSkillWorkshopAgentScope(state, requestAgentId);
  }
  if (state.skillWorkshopLoading) {
    return;
  }
  if (state.skillWorkshopLoaded && !options?.force) {
    return;
  }
  const generation = readGeneration(state);
  const isCurrentRead = () =>
    readGeneration(state) === generation &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    skillWorkshopAgentParams(context).agentId === requestAgentId;
  state.skillWorkshopLoading = true;
  state.skillWorkshopError = null;
  try {
    const result = await client.request<SkillProposalManifest>("skills.proposals.list", {
      agentId: requestAgentId,
    });
    if (!isCurrentRead()) {
      return;
    }
    const previousByKey = new Map(
      state.skillWorkshopProposals.map((proposal) => [proposal.key, proposal]),
    );
    const proposals = (result.proposals ?? [])
      .toSorted((a, b) => parseDateMs(b.updatedAt) - parseDateMs(a.updatedAt))
      .map((entry) => proposalFromManifest(entry, previousByKey.get(entry.id)));
    state.skillWorkshopProposals = proposals;
    state.skillWorkshopInstalledSkills = result.installedSkills;
    if (!result.installedSkills.some((skill) => skill.name === state.skillWorkshopInstalledName)) {
      state.skillWorkshopInstalledName = null;
    }
    state.skillWorkshopLoaded = true;
    if (state.skillWorkshopMode === "skills") {
      const installed = state.skillWorkshopInstalledSkills;
      await Promise.all(
        installed.map((skill) =>
          loadInstalledSkill(state, context, skill, {
            onProgress: options?.onProgress,
            isCurrent: options?.isCurrent,
          }),
        ),
      );
      if (isCurrentRead() && state.skillWorkshopInstalledSkills === installed) {
        state.skillWorkshopInstalledName ??=
          (installed.find((skill) => changedSkillWorkshopVersion(skill.read)) ?? installed[0])
            ?.name ?? null;
      }
      return;
    }
    const visibleProposals = filterSkillWorkshopProposals(proposals, state.skillWorkshopQuery);
    const selectedProposal = proposals.find(
      (proposal) => proposal.key === state.skillWorkshopSelectedKey,
    );
    if (!visibleProposals.some((proposal) => proposal.key === selectedProposal?.key)) {
      state.skillWorkshopSelectedKey = visibleProposals[0]?.key ?? null;
      // Only a refresh that actually reassigns the pane owns the selection
      // fence; otherwise a background reload would silence an in-flight click.
      if (state.skillWorkshopSelectedKey) {
        markSkillWorkshopSelectionRequest(state, state.skillWorkshopSelectedKey);
      }
    }
    const selectedKey = state.skillWorkshopSelectedKey;
    if (selectedKey) {
      // Route data retains the selection but not its ephemeral request fence.
      if (!selectionRequestByState.has(state)) {
        markSkillWorkshopSelectionRequest(state, selectedKey);
      }
      await loadSkillWorkshopProposalDetail(state, context, selectedKey, {
        isCurrent: options?.isCurrent,
      });
    }
  } catch (err) {
    if (isCurrentRead()) {
      state.skillWorkshopError = formatUiError(err);
    }
  } finally {
    if (readGeneration(state) === generation) {
      state.skillWorkshopLoading = false;
      if (
        options?.isCurrent?.() !== false &&
        context.gateway.snapshot.client === client &&
        skillWorkshopAgentParams(context).agentId !== requestAgentId
      ) {
        void loadSkillWorkshopProposals(state, context, { ...options, force: true });
      }
    }
  }
}

type SkillWorkshopGatewayClient = NonNullable<ApplicationGateway["snapshot"]["client"]>;

// Rapid suggestion clicks overlap: each inspect awaits the Gateway, so a slower
// earlier request must neither re-issue the same call nor publish its selection
// or error after a newer click won the pane. Both fences are keyed on the live
// state object so nothing reaches the persisted route data.
const inspectRequestsByState = new WeakMap<SkillWorkshopState, Map<string, Promise<boolean>>>();
const selectionRequestByState = new WeakMap<SkillWorkshopState, string>();

function inspectRequests(state: SkillWorkshopState): Map<string, Promise<boolean>> {
  const existing = inspectRequestsByState.get(state);
  if (existing) {
    return existing;
  }
  const requests = new Map<string, Promise<boolean>>();
  inspectRequestsByState.set(state, requests);
  return requests;
}

function markSkillWorkshopSelectionRequest(state: SkillWorkshopState, proposalId: string): void {
  selectionRequestByState.set(state, proposalId);
}

function isLatestSkillWorkshopSelection(state: SkillWorkshopState, proposalId: string): boolean {
  return selectionRequestByState.get(state) === proposalId;
}

async function inspectSkillWorkshopProposal(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  client: SkillWorkshopGatewayClient,
  proposalId: string,
  existing: SkillWorkshopProposal | undefined,
  options?: SkillWorkshopLoadOptions,
): Promise<boolean> {
  const requestAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = requestAgentId;
  }
  const generation = readGeneration(state);
  const isCurrentRead = () =>
    readGeneration(state) === generation &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    state.skillWorkshopAgentId === requestAgentId &&
    skillWorkshopAgentParams(context).agentId === requestAgentId;
  state.skillWorkshopInspectingKey = proposalId;
  state.skillWorkshopError = null;
  try {
    const requestParams = { agentId: requestAgentId, proposalId };
    const result = await client.request<SkillProposalInspectResult>(
      "skills.proposals.inspect",
      requestParams,
    );
    if (!isCurrentRead()) {
      return false;
    }
    mergeProposal(state, proposalFromInspect(result, existing));
    return true;
  } catch (err) {
    // Only the revision the operator is waiting on may publish an error; a
    // superseded click stays quiet.
    if (isCurrentRead() && isLatestSkillWorkshopSelection(state, proposalId)) {
      state.skillWorkshopError = formatUiError(err);
    }
    return false;
  } finally {
    if (isCurrentRead() && state.skillWorkshopInspectingKey === proposalId) {
      state.skillWorkshopInspectingKey = null;
    }
  }
}

export function loadSkillWorkshopProposalDetail(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  options?: SkillWorkshopLoadOptions,
): Promise<boolean> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || options?.isCurrent?.() === false) {
    return Promise.resolve(false);
  }
  const existing = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (existing?.degradedState || (existing?.bodyLoaded && !options?.force)) {
    return Promise.resolve(true);
  }
  const requests = inspectRequests(state);
  const inFlight = requests.get(proposalId);
  if (inFlight) {
    return inFlight;
  }
  const request = inspectSkillWorkshopProposal(
    state,
    context,
    client,
    proposalId,
    existing,
    options,
  ).finally(() => {
    if (requests.get(proposalId) === request) {
      requests.delete(proposalId);
    }
  });
  requests.set(proposalId, request);
  return request;
}

export async function selectSkillWorkshopProposal(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
): Promise<void> {
  markSkillWorkshopSelectionRequest(state, proposalId);
  const current = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (!current?.bodyLoaded) {
    const loaded = await loadSkillWorkshopProposalDetail(state, context, proposalId);
    if (!loaded || !isLatestSkillWorkshopSelection(state, proposalId)) {
      return;
    }
  }
  state.skillWorkshopSelectedKey = proposalId;
}
