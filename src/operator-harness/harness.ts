import fs from "node:fs/promises";
import path from "node:path";
import { type RuntimeEnv } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { runArtifactWalkthrough } from "./browser-runtime.js";
import { loadHarnessConfig, saveHarnessState, type LoadedHarnessConfig } from "./config.js";
import { findPullRequestByBranch } from "./github-pr.js";
import { LinearClient, extractNotionUrlsFromText, requireLinearApiKey } from "./linear-client.js";
import { NotionClient } from "./notion-client.js";
import { PaperclipClient } from "./paperclip-client.js";
import {
  buildSpecPacket,
  buildTaskPacket,
  checkArtifacts,
  findSubtaskByRole,
  groupManagedIssues,
  isManagedIssueBlocked,
  renderSpecPacket,
  renderTaskPacket,
} from "./spec-packet.js";
import { buildTaskExecutionContract } from "./task-contract.js";
import type {
  HarnessAgentConfig,
  ManagedIssueGroup,
  ManagedIssueSummary,
  NextTicketCandidate,
  OperatorHarnessSummary,
  OperatorPulseSnapshot,
  OperatorPulseTicket,
  OperatorRole,
  SpecPacket,
} from "./types.js";
import { prepareRoleWorkspace, writeWorkspacePackets } from "./workspace-manager.js";

const BUILDER_PROMPT_TEMPLATE = trimPrompt(`
You are {{agent.name}} running inside the OpenClaw operator harness.

Wake context:
- issueId: {{context.issueId}}
- wakeReason: {{context.wakeReason}}
- runId: {{run.id}}

Use the $paperclip skill immediately. Read the assigned issue description and comments, follow the task packet exactly, perform the local implementation or review work, collect the required evidence, update the issue with a concise evidence-backed comment, and then exit the heartbeat.
The task packet is the source of truth for repoCwd, branchName, artifactDir, startupCommand, validationCommand, finalizeCommand, browser steps, and PR requirements.
`);

function trimPrompt(text: string) {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

type ProvisionResult = {
  loaded: LoadedHarnessConfig;
  paperclip: PaperclipClient;
};

type EvidenceStatus = {
  missingEvidence: boolean;
  taskStates: string[];
};

async function loadProvisionedHarness(configPath?: string): Promise<ProvisionResult> {
  const loaded = await loadHarnessConfig(configPath);
  const paperclip = new PaperclipClient(loaded.config.paperclip.apiBase);
  return { loaded, paperclip };
}

function resolveAgentConfigByRole(loaded: LoadedHarnessConfig, role: OperatorRole) {
  switch (role) {
    case "builder":
      return loaded.config.agents.builder;
    case "qa":
      return loaded.config.agents.qa;
    case "ux":
      return loaded.config.agents.ux ?? null;
    case "ai":
      return loaded.config.agents.ai ?? null;
    default:
      return null;
  }
}

async function ensureAgent(
  paperclip: PaperclipClient,
  loaded: LoadedHarnessConfig,
  companyId: string,
  agentConfig: HarnessAgentConfig,
) {
  const agents = await paperclip.listAgents(companyId);
  const existing = agents.find((agent) => agent.name === agentConfig.name) ?? null;
  if (existing) {
    await paperclip.updateAgent(existing.id, {
      config: agentConfig,
      cwd: loaded.config.workspace.repoCwd,
      promptTemplate: BUILDER_PROMPT_TEMPLATE,
    });
    return existing.id;
  }
  const created = await paperclip.createAgent({
    companyId,
    config: agentConfig,
    cwd: loaded.config.workspace.repoCwd,
    promptTemplate: BUILDER_PROMPT_TEMPLATE,
  });
  return created.id;
}

async function ensureProject(
  paperclip: PaperclipClient,
  loaded: LoadedHarnessConfig,
  companyId: string,
) {
  const projects = await paperclip.listProjects(companyId);
  const existing =
    projects.find((project) => project.name === loaded.config.paperclip.projectName) ?? null;
  if (existing) {
    return {
      projectId: existing.id,
      workspaceId: existing.primaryWorkspace?.id,
    };
  }
  const created = await paperclip.createProject({
    companyId,
    name: loaded.config.paperclip.projectName,
    repoCwd: loaded.config.workspace.repoCwd,
    repoRef: loaded.config.workspace.baseBranch,
    repoUrl: loaded.config.workspace.repoUrl,
  });
  return {
    projectId: created.id,
    workspaceId: created.primaryWorkspace?.id,
  };
}

async function ensureProvisioned(configPath?: string) {
  const { loaded, paperclip } = await loadProvisionedHarness(configPath);
  const companies = await paperclip.listCompanies();
  const company =
    companies.find((candidate) => candidate.id === loaded.state.companyId) ??
    companies.find((candidate) => candidate.name === loaded.config.paperclip.companyName) ??
    (await paperclip.createCompany({ name: loaded.config.paperclip.companyName }));
  const project = await ensureProject(paperclip, loaded, company.id);
  const agentIds = {
    builder: await ensureAgent(paperclip, loaded, company.id, loaded.config.agents.builder),
    qa: await ensureAgent(paperclip, loaded, company.id, loaded.config.agents.qa),
    ...(loaded.config.agents.ux
      ? { ux: await ensureAgent(paperclip, loaded, company.id, loaded.config.agents.ux) }
      : {}),
    ...(loaded.config.agents.ai
      ? { ai: await ensureAgent(paperclip, loaded, company.id, loaded.config.agents.ai) }
      : {}),
  };
  const nextState = {
    ...loaded.state,
    companyId: company.id,
    projectId: project.projectId,
    projectWorkspaceId: project.workspaceId,
    agentIds,
  };
  await saveHarnessState(loaded, nextState);
  return {
    loaded: {
      ...loaded,
      state: nextState,
    },
    paperclip,
  };
}

async function listHarnessIssues(provisioned: ProvisionResult) {
  const companyId = provisioned.loaded.state.companyId;
  const projectId = provisioned.loaded.state.projectId;
  if (!companyId || !projectId) {
    throw new Error("Harness is not provisioned. Run bootstrap first.");
  }
  return provisioned.paperclip.listIssues(companyId, { projectId });
}

async function findGroupByTicketKey(provisioned: ProvisionResult, ticketKey: string) {
  const groups = groupManagedIssues(await listHarnessIssues(provisioned));
  return (
    groups.find(
      (group) => group.specPacket.externalTicketId.toUpperCase() === ticketKey.toUpperCase(),
    ) ?? null
  );
}

async function loadSpecPacketForTicket(provisioned: ProvisionResult, ticketKey: string) {
  const linear = new LinearClient(requireLinearApiKey());
  const notion = new NotionClient(provisioned.loaded.config.notion);
  const issue = await linear.getIssueByIdentifier(
    provisioned.loaded.config.linear.teamKey,
    ticketKey,
    provisioned.loaded.config.linear.listLimit ?? 100,
  );
  const notionUrls = Array.from(
    new Set([
      ...(provisioned.loaded.config.notion.baselineUrls ?? []),
      ...extractNotionUrlsFromText(issue.description),
      ...(provisioned.loaded.config.ticketOverrides?.[ticketKey]?.notionUrls ?? []),
    ]),
  );
  const notionEntries = await notion.fetchPages(notionUrls);
  return buildSpecPacket({
    config: provisioned.loaded.config,
    issue,
    notionEntries,
  });
}

async function buildRoleTaskPacket(input: {
  provisioned: ProvisionResult;
  specPacket: SpecPacket;
  role: OperatorRole;
  summary: string;
  prUrl?: string | null;
}) {
  const { provisioned, specPacket, role } = input;
  const workspace = await prepareRoleWorkspace({
    config: provisioned.loaded.config,
    ticketKey: specPacket.externalTicketId,
    title: specPacket.title,
    role,
  });
  const execution = buildTaskExecutionContract({
    config: provisioned.loaded.config,
    specPacket,
    role,
  });
  const prTitle = `[${specPacket.externalTicketId}] ${specPacket.title}`;
  const taskPacket = buildTaskPacket({
    role,
    specPacket,
    summary: input.summary,
    artifactDir: workspace.artifactDir,
    repoRelativeArtifactDir: workspace.repoRelativeArtifactDir,
    repoCwd: workspace.cwd,
    startupCommand: execution.startupCommand,
    healthcheckUrl: execution.healthcheckUrl,
    browserWalkthrough: execution.browserWalkthrough,
    branchName: workspace.branchName,
    baseBranch: provisioned.loaded.config.workspace.baseBranch,
    gitRemoteName: "origin",
    prRequired: true,
    prTitle,
    prBodyPath: path.join(workspace.packetDir, "pr-body.md"),
    prUrl: input.prUrl ?? null,
    specPacketPath: workspace.specPacketPath,
    taskPacketPath: workspace.taskPacketPath,
  });
  await writeWorkspacePackets({ workspace, specPacket, taskPacket });
  return taskPacket;
}

async function syncBuilderPullRequest(
  provisioned: ProvisionResult,
  group: ManagedIssueGroup,
): Promise<string | null> {
  const builderIssue = findSubtaskByRole(group, "builder");
  const taskPacket = builderIssue?.taskPacket;
  if (!builderIssue || !taskPacket || !group.specPacket.repoUrl) {
    return null;
  }
  const pullRequest = await findPullRequestByBranch({
    repoUrl: group.specPacket.repoUrl,
    branchName: taskPacket.branchName,
    cwd: taskPacket.repoCwd,
  }).catch(() => null);
  if (!pullRequest) {
    return null;
  }
  if (taskPacket.prUrl === pullRequest.url) {
    return pullRequest.url;
  }
  const nextPacket = {
    ...taskPacket,
    prUrl: pullRequest.url,
  };
  await provisioned.paperclip.updateIssue(builderIssue.id, {
    description: renderTaskPacket(nextPacket),
  });
  if (taskPacket.taskPacketPath) {
    await fs.writeFile(taskPacket.taskPacketPath, `${JSON.stringify(nextPacket, null, 2)}\n`);
  }
  return pullRequest.url;
}

async function upsertManagedIssueGroup(
  provisioned: ProvisionResult,
  specPacket: ReturnType<typeof buildSpecPacket>,
) {
  const companyId = provisioned.loaded.state.companyId;
  const projectId = provisioned.loaded.state.projectId;
  const builderId = provisioned.loaded.state.agentIds?.builder;
  if (!companyId || !projectId || !builderId) {
    throw new Error("Harness is not provisioned. Run bootstrap first.");
  }

  const existingGroup = await findGroupByTicketKey(provisioned, specPacket.externalTicketId);
  const parentBody = {
    title: `[${specPacket.externalTicketId}] ${specPacket.title}`,
    description: renderSpecPacket(specPacket),
    projectId,
    status: existingGroup?.parent.status ?? "todo",
    priority: "high",
  };
  const parent = existingGroup
    ? await provisioned.paperclip.updateIssue(existingGroup.parent.id, parentBody)
    : await provisioned.paperclip.createIssue(companyId, parentBody);

  const builderTask = await buildRoleTaskPacket({
    provisioned,
    specPacket,
    role: "builder",
    summary: `Implement ${specPacket.externalTicketId} and collect the required MVP evidence.`,
  });

  const existingImplementation =
    existingGroup?.subtasks.find((task) => task.taskPacket?.role === "builder") ?? null;
  const implementation = existingImplementation
    ? await provisioned.paperclip.updateIssue(existingImplementation.id, {
        title: `Implement ${specPacket.externalTicketId}`,
        description: renderTaskPacket(builderTask),
        parentId: parent.id,
        projectId,
        assigneeAgentId: builderId,
        status: existingImplementation.status === "done" ? "done" : "todo",
        priority: "high",
      })
    : await provisioned.paperclip.createIssue(companyId, {
        title: `Implement ${specPacket.externalTicketId}`,
        description: renderTaskPacket(builderTask),
        parentId: parent.id,
        projectId,
        assigneeAgentId: builderId,
        status: "todo",
        priority: "high",
      });

  return { parent, implementation, existingGroup, builderTask };
}

async function reconcileParentCompletion(provisioned: ProvisionResult, group: ManagedIssueGroup) {
  const artifactChecks = await Promise.all(
    group.subtasks
      .filter((task) => task.taskPacket)
      .map((task) =>
        checkArtifacts(task.taskPacket!.artifactDir, task.taskPacket!.requiredArtifacts),
      ),
  );
  const allTasksDone = group.subtasks.every((task) => task.status === "done");
  const missingEvidence = artifactChecks.some((result) => result.missingArtifacts.length > 0);
  const builderTask = findSubtaskByRole(group, "builder");
  const hasPullRequest =
    !builderTask?.taskPacket?.prRequired || Boolean(builderTask.taskPacket.prUrl);
  if (allTasksDone && !missingEvidence && hasPullRequest && group.parent.status !== "done") {
    group.parent = await provisioned.paperclip.updateIssue(group.parent.id, {
      status: "done",
      comment: `Operator harness marked this parent done after all subtasks completed and evidence was present.`,
    });
  }
}

async function collectEvidenceStatus(groups: ManagedIssueGroup[]) {
  const evidenceByParentId = new Map<string, EvidenceStatus>();
  for (const group of groups) {
    const taskStates: string[] = [];
    let missingEvidence = false;
    for (const task of group.subtasks) {
      const packet = task.taskPacket;
      if (!packet) {
        continue;
      }
      if (task.status !== "done") {
        taskStates.push(`${packet.role}:pending`);
        continue;
      }
      const artifactCheck = await checkArtifacts(packet.artifactDir, packet.requiredArtifacts);
      if (artifactCheck.missingArtifacts.length === 0) {
        taskStates.push(`${packet.role}:complete`);
        continue;
      }
      missingEvidence = true;
      taskStates.push(`${packet.role}:missing(${artifactCheck.missingArtifacts.join("|")})`);
    }
    evidenceByParentId.set(group.parent.id, {
      missingEvidence,
      taskStates,
    });
  }
  return evidenceByParentId;
}

function summarizeGroups(
  groups: ManagedIssueGroup[],
  evidenceByParentId: Map<string, EvidenceStatus>,
) {
  const summary: OperatorHarnessSummary = {
    ready: 0,
    active: 0,
    blocked: 0,
    pendingReviews: 0,
    missingEvidence: 0,
  };
  for (const group of groups) {
    const evidence = evidenceByParentId.get(group.parent.id);
    if (evidence?.missingEvidence) {
      summary.missingEvidence += 1;
    }
    const builderTask = findSubtaskByRole(group, "builder");
    if (isManagedIssueBlocked(group)) {
      summary.blocked += 1;
      continue;
    }
    if (group.subtasks.some((task) => task.activeRun || task.status === "in_progress")) {
      summary.active += 1;
      continue;
    }
    const pendingRequiredReviews = group.specPacket.requiredReviewRoles.filter(
      (role) => findSubtaskByRole(group, role)?.status !== "done",
    );
    if (builderTask && builderTask.status === "done" && pendingRequiredReviews.length > 0) {
      summary.pendingReviews += 1;
      continue;
    }
    if (builderTask && builderTask.status !== "done") {
      summary.ready += 1;
    }
  }
  return summary;
}

function renderStatusTable(
  groups: ManagedIssueGroup[],
  evidenceByParentId: Map<string, EvidenceStatus>,
) {
  return renderTable({
    columns: [
      { key: "ticket", header: "Ticket", minWidth: 12 },
      { key: "status", header: "Status", minWidth: 12 },
      { key: "reviews", header: "Reviews", minWidth: 12 },
      { key: "evidence", header: "Evidence", minWidth: 14 },
      { key: "title", header: "Title", flex: true, minWidth: 24 },
    ],
    rows: groups.map((group) => {
      const reviewStates = group.specPacket.requiredReviewRoles.map((role) => {
        const task = findSubtaskByRole(group, role);
        return `${role}:${task?.status ?? "todo"}`;
      });
      const spotCheckTask = findSubtaskByRole(group, "spot-check");
      if (spotCheckTask) {
        reviewStates.push(`spot-check:${spotCheckTask.status}`);
      }
      return {
        ticket: group.specPacket.externalTicketId,
        status: group.parent.status,
        reviews: reviewStates.length > 0 ? reviewStates.join(", ") : "-",
        evidence: evidenceByParentId.get(group.parent.id)?.taskStates.join(", ") || "-",
        title: group.specPacket.title,
      };
    }),
    border: "unicode",
  });
}

export function summarizeOperatorTicket(
  group: ManagedIssueGroup,
  evidence: EvidenceStatus = { missingEvidence: false, taskStates: [] },
): OperatorPulseTicket {
  const builderTask = findSubtaskByRole(group, "builder");
  const requiredReviewRoles = [...group.specPacket.requiredReviewRoles];
  const reviewStatuses = requiredReviewRoles.map((role) => ({
    role,
    status: findSubtaskByRole(group, role)?.status ?? null,
  }));
  const missingReviewRoles = reviewStatuses
    .filter((entry) => entry.status !== "done")
    .map((entry) => entry.role);
  const spotCheckTask = findSubtaskByRole(group, "spot-check");
  const activeRun = group.subtasks.some((task) => task.activeRun || task.status === "in_progress");
  const reviewRequested = reviewStatuses.some((entry) => entry.status !== null);
  const reviewNeeded = builderTask?.status === "done" && missingReviewRoles.length > 0;
  const reviewsDone =
    builderTask?.status === "done" &&
    requiredReviewRoles.every((role) => !missingReviewRoles.includes(role));
  const spotCheckNeeded = reviewsDone && spotCheckTask?.status !== "done";

  let lifecycle: OperatorPulseTicket["lifecycle"] = "ready";
  if (
    group.parent.status === "done" &&
    !evidence.missingEvidence &&
    spotCheckTask?.status === "done"
  ) {
    lifecycle = "done";
  } else if (isManagedIssueBlocked(group)) {
    lifecycle = "blocked";
  } else if (activeRun) {
    lifecycle = "active";
  } else if (reviewNeeded && !reviewRequested) {
    lifecycle = "review-needed";
  } else if (reviewNeeded) {
    lifecycle = "reviewing";
  } else if (spotCheckNeeded) {
    lifecycle = "spot-check-needed";
  } else if (
    builderTask?.status === "done" &&
    !evidence.missingEvidence &&
    (!spotCheckTask || spotCheckTask.status === "done")
  ) {
    lifecycle = "done";
  }

  return {
    ticketKey: group.specPacket.externalTicketId,
    title: group.specPacket.title,
    upstreamUrl: group.specPacket.upstreamUrl,
    parentStatus: group.parent.status,
    lifecycle,
    builderStatus: builderTask?.status ?? null,
    requiredReviewRoles,
    reviewRequested,
    reviewStatuses,
    missingReviewRoles,
    spotCheckStatus: spotCheckTask?.status ?? null,
    spotCheckNeeded,
    activeRun,
    missingEvidence: evidence.missingEvidence,
    evidence: evidence.taskStates,
    updatedAt: group.parent.updatedAt,
  };
}

function buildOperatorPulseSnapshot(
  groups: ManagedIssueGroup[],
  evidenceByParentId: Map<string, EvidenceStatus>,
  summary: OperatorHarnessSummary,
  nextCandidate: NextTicketCandidate | null,
  paused: boolean,
  agents: Awaited<ReturnType<PaperclipClient["listAgents"]>>,
  liveRuns: Awaited<ReturnType<PaperclipClient["listLiveRuns"]>>,
): OperatorPulseSnapshot {
  return {
    summary,
    tickets: groups
      .map((group) => summarizeOperatorTicket(group, evidenceByParentId.get(group.parent.id)))
      .toSorted((left, right) => left.ticketKey.localeCompare(right.ticketKey)),
    nextCandidate,
    paused,
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      companyId: agent.companyId,
    })),
    liveRuns,
  };
}

function sortQueueCandidate(left: ManagedIssueGroup, right: ManagedIssueGroup) {
  const leftPriority = left.specPacket.externalTicketId;
  const rightPriority = right.specPacket.externalTicketId;
  return leftPriority.localeCompare(rightPriority);
}

function normalizeProjectName(value: string | null) {
  return value?.trim().toLowerCase() ?? null;
}

function matchesConfiguredProject(
  projectName: string | null,
  configuredNames: string[] | undefined,
) {
  if (!configuredNames || configuredNames.length === 0) {
    return false;
  }
  const normalized = normalizeProjectName(projectName);
  if (!normalized) {
    return false;
  }
  return configuredNames.some((name) => normalizeProjectName(name) === normalized);
}

export function chooseReadyBacklogIssue(
  issues: Awaited<ReturnType<LinearClient["listTeamIssues"]>>,
  config: LoadedHarnessConfig["config"]["linear"],
  existingKeys: Set<string>,
) {
  return (
    issues
      .filter((issue) => {
        const matchesType = config.readyStateTypes.includes(issue.state.type);
        const matchesName = config.readyStateNames.includes(issue.state.name);
        const isExcludedProject = matchesConfiguredProject(
          issue.projectName,
          config.excludedProjectNames,
        );
        return (
          (matchesType || matchesName) && !existingKeys.has(issue.identifier) && !isExcludedProject
        );
      })
      .toSorted((left, right) => {
        const leftPreferred = matchesConfiguredProject(
          left.projectName,
          config.preferredProjectNames,
        );
        const rightPreferred = matchesConfiguredProject(
          right.projectName,
          config.preferredProjectNames,
        );
        if (leftPreferred !== rightPreferred) {
          return leftPreferred ? -1 : 1;
        }
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        return left.createdAt.localeCompare(right.createdAt);
      })[0] ?? null
  );
}

async function selectNextTicket(provisioned: ProvisionResult) {
  return (await selectNextTicketCandidate(provisioned))?.ticketKey ?? null;
}

async function selectNextTicketCandidate(
  provisioned: ProvisionResult,
): Promise<NextTicketCandidate | null> {
  const groups = groupManagedIssues(await listHarnessIssues(provisioned));
  const pendingReviews = groups
    .filter((group) => {
      if (isManagedIssueBlocked(group)) {
        return false;
      }
      const builderTask = findSubtaskByRole(group, "builder");
      if (!builderTask || builderTask.status !== "done") {
        return false;
      }
      return group.subtasks.some(
        (task) => task.taskPacket?.role !== "builder" && task.status !== "done",
      );
    })
    .toSorted(sortQueueCandidate);
  const pendingReview = pendingReviews[0];
  if (pendingReview) {
    return {
      ticketKey: pendingReview.specPacket.externalTicketId,
      title: pendingReview.specPacket.title,
      url: pendingReview.specPacket.upstreamUrl,
      priority: null,
      state: null,
      reason: "pending-review",
    };
  }
  const linear = new LinearClient(requireLinearApiKey());
  const issues = await linear.listTeamIssues(
    provisioned.loaded.config.linear.teamKey,
    provisioned.loaded.config.linear.listLimit ?? 100,
  );
  const existingKeys = new Set(groups.map((group) => group.specPacket.externalTicketId));
  const readyIssue = chooseReadyBacklogIssue(
    issues,
    provisioned.loaded.config.linear,
    existingKeys,
  );
  if (!readyIssue) {
    return null;
  }
  return {
    ticketKey: readyIssue.identifier,
    title: readyIssue.title,
    url: readyIssue.url,
    priority: readyIssue.priority,
    state: readyIssue.state,
    reason: "ready-backlog",
  };
}

async function ensureReviewSubtasks(provisioned: ProvisionResult, group: ManagedIssueGroup) {
  const companyId = provisioned.loaded.state.companyId;
  const projectId = provisioned.loaded.state.projectId;
  if (!companyId || !projectId) {
    throw new Error("Harness is not provisioned. Run bootstrap first.");
  }
  const pullRequestUrl = await syncBuilderPullRequest(provisioned, group);
  if (!pullRequestUrl) {
    throw new Error(
      `Builder pull request is missing for ${group.specPacket.externalTicketId}. The builder must push the branch and create the PR before review can start.`,
    );
  }

  const createdOrUpdated: ManagedIssueSummary[] = [];
  for (const role of group.specPacket.requiredReviewRoles) {
    const config = resolveAgentConfigByRole(provisioned.loaded, role);
    const agentId = provisioned.loaded.state.agentIds?.[role];
    if (!config || !agentId) {
      throw new Error(`Missing configured reviewer for role ${role}`);
    }
    const existing = findSubtaskByRole(group, role);
    const taskPacket = await buildRoleTaskPacket({
      provisioned,
      specPacket: group.specPacket,
      role,
      summary: `${config.title}. Re-run the app locally, validate the flow independently, and collect your own evidence.`,
      prUrl: pullRequestUrl,
    });
    const body = {
      title: `${role.toUpperCase()} Review ${group.specPacket.externalTicketId}`,
      description: renderTaskPacket(taskPacket),
      parentId: group.parent.id,
      projectId,
      assigneeAgentId: agentId,
      status: existing?.status === "done" ? "done" : "todo",
      priority: "medium",
    };
    const updated = existing
      ? await provisioned.paperclip.updateIssue(existing.id, body)
      : await provisioned.paperclip.createIssue(companyId, body);
    createdOrUpdated.push(updated);
  }
  await provisioned.paperclip.updateIssue(group.parent.id, {
    status: "in_review",
    comment: `Operator requested reviews for ${group.specPacket.requiredReviewRoles.join(", ")}.`,
  });
  return createdOrUpdated;
}

async function writeReviewFile(artifactDir: string, lines: string[]) {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "review.md"), `${lines.join("\n")}\n`);
}

export async function operatorBootstrap(configPath: string | undefined, runtime: RuntimeEnv) {
  const provisioned = await ensureProvisioned(configPath);
  runtime.log(`Company: ${provisioned.loaded.state.companyId}`);
  runtime.log(`Project: ${provisioned.loaded.state.projectId}`);
  for (const [role, agentId] of Object.entries(provisioned.loaded.state.agentIds ?? {})) {
    runtime.log(`${role}: ${agentId}`);
  }
}

export async function operatorStatus(
  configPath: string | undefined,
  runtime: RuntimeEnv,
  json = false,
) {
  const provisioned = await ensureProvisioned(configPath);
  const groups = groupManagedIssues(await listHarnessIssues(provisioned));
  for (const group of groups) {
    await syncBuilderPullRequest(provisioned, group).catch(() => null);
    await reconcileParentCompletion(provisioned, group);
  }
  const evidenceByParentId = await collectEvidenceStatus(groups);
  const summary = summarizeGroups(groups, evidenceByParentId);
  const nextCandidate = await selectNextTicketCandidate(provisioned);
  const companyId = provisioned.loaded.state.companyId;
  const agents = companyId ? await provisioned.paperclip.listAgents(companyId) : [];
  const liveRuns = companyId ? await provisioned.paperclip.listLiveRuns(companyId) : [];
  if (json) {
    runtime.log(
      JSON.stringify(
        {
          summary,
          groups,
          nextCandidate,
          paused: provisioned.loaded.state.paused === true,
          agents: agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            companyId: agent.companyId,
          })),
          liveRuns,
        },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log(
    `${theme.heading("Operator Harness")} ready=${summary.ready} active=${summary.active} blocked=${summary.blocked} pendingReviews=${summary.pendingReviews} missingEvidence=${summary.missingEvidence} next=${nextCandidate?.ticketKey ?? "-"}`,
  );
  if (nextCandidate) {
    runtime.log(
      `Suggested next: ${nextCandidate.ticketKey} (${nextCandidate.reason}) - ${nextCandidate.title}`,
    );
  }
  runtime.log(renderStatusTable(groups, evidenceByParentId));
}

export async function operatorPulse(
  configPath: string | undefined,
  runtime: RuntimeEnv,
  json = false,
) {
  const provisioned = await ensureProvisioned(configPath);
  const groups = groupManagedIssues(await listHarnessIssues(provisioned));
  for (const group of groups) {
    await syncBuilderPullRequest(provisioned, group).catch(() => null);
    await reconcileParentCompletion(provisioned, group);
  }
  const evidenceByParentId = await collectEvidenceStatus(groups);
  const summary = summarizeGroups(groups, evidenceByParentId);
  const nextCandidate = await selectNextTicketCandidate(provisioned);
  const companyId = provisioned.loaded.state.companyId;
  const agents = companyId ? await provisioned.paperclip.listAgents(companyId) : [];
  const liveRuns = companyId ? await provisioned.paperclip.listLiveRuns(companyId) : [];
  const snapshot = buildOperatorPulseSnapshot(
    groups,
    evidenceByParentId,
    summary,
    nextCandidate,
    provisioned.loaded.state.paused === true,
    agents,
    liveRuns,
  );
  if (json) {
    runtime.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  runtime.log(
    `${theme.heading("Operator Pulse")} ready=${snapshot.summary.ready} active=${snapshot.summary.active} blocked=${snapshot.summary.blocked} pendingReviews=${snapshot.summary.pendingReviews} missingEvidence=${snapshot.summary.missingEvidence} next=${snapshot.nextCandidate?.ticketKey ?? "-"}`,
  );
  for (const ticket of snapshot.tickets) {
    runtime.log(
      `${ticket.ticketKey} ${ticket.lifecycle} builder=${ticket.builderStatus ?? "-"} reviews=${ticket.reviewStatuses.map((entry) => `${entry.role}:${entry.status ?? "todo"}`).join(",")} spot-check=${ticket.spotCheckStatus ?? "todo"}`,
    );
  }
}

export async function operatorRecommendNext(
  configPath: string | undefined,
  runtime: RuntimeEnv,
  json = false,
) {
  const provisioned = await ensureProvisioned(configPath);
  const candidate = await selectNextTicketCandidate(provisioned);
  if (json) {
    runtime.log(JSON.stringify({ nextCandidate: candidate }, null, 2));
    return;
  }
  if (!candidate) {
    runtime.log("No eligible ticket found.");
    return;
  }
  runtime.log(`${candidate.ticketKey} (${candidate.reason})`);
  runtime.log(candidate.title);
  runtime.log(candidate.url);
}

export async function operatorStartTicket(
  configPath: string | undefined,
  ticketKey: string,
  runtime: RuntimeEnv,
) {
  const provisioned = await ensureProvisioned(configPath);
  if (provisioned.loaded.state.paused) {
    throw new Error("Operator harness is paused. Run resume-all first.");
  }
  const specPacket = await loadSpecPacketForTicket(provisioned, ticketKey);
  const { parent, implementation, builderTask } = await upsertManagedIssueGroup(
    provisioned,
    specPacket,
  );
  await provisioned.paperclip.addComment(
    parent.id,
    trimPrompt(`
Dispatched builder for ${ticketKey}.

- Implementation issue: ${implementation.identifier ?? implementation.id}
- Branch: ${builderTask.branchName}
- Workspace: ${builderTask.repoCwd}
    `),
  );
  const builderId = provisioned.loaded.state.agentIds?.builder;
  if (builderId) {
    await provisioned.paperclip.wakeAgent(builderId, implementation.id, "operator_start_ticket");
  }
  runtime.log(`Parent issue: ${parent.identifier ?? parent.id}`);
  runtime.log(`Implementation issue: ${implementation.identifier ?? implementation.id}`);
}

export async function operatorNextTicket(configPath: string | undefined, runtime: RuntimeEnv) {
  const provisioned = await ensureProvisioned(configPath);
  if (provisioned.loaded.state.paused) {
    throw new Error("Operator harness is paused. Run resume-all first.");
  }
  const ticketKey = await selectNextTicket(provisioned);
  if (!ticketKey) {
    runtime.log("No eligible ticket found.");
    return;
  }
  await operatorStartTicket(configPath, ticketKey, runtime);
}

export async function operatorRequestReview(
  configPath: string | undefined,
  ticketKey: string,
  runtime: RuntimeEnv,
) {
  const provisioned = await ensureProvisioned(configPath);
  const group = await findGroupByTicketKey(provisioned, ticketKey);
  if (!group) {
    throw new Error(`No managed Paperclip issue found for ${ticketKey}. Start the ticket first.`);
  }
  const builderTask = findSubtaskByRole(group, "builder");
  if (!builderTask || builderTask.status !== "done") {
    throw new Error(`Builder task is not done for ${ticketKey}. Review cannot start yet.`);
  }
  const reviewIssues = await ensureReviewSubtasks(provisioned, group);
  for (const issue of reviewIssues) {
    if (issue.assigneeAgentId) {
      await provisioned.paperclip.wakeAgent(
        issue.assigneeAgentId,
        issue.id,
        "operator_request_review",
      );
    }
  }
  runtime.log(
    `Requested reviews for ${ticketKey}: ${reviewIssues.map((issue) => issue.identifier ?? issue.id).join(", ")}`,
  );
}

export async function operatorSpotCheck(
  configPath: string | undefined,
  ticketKey: string,
  runtime: RuntimeEnv,
) {
  const provisioned = await ensureProvisioned(configPath);
  const group = await findGroupByTicketKey(provisioned, ticketKey);
  if (!group) {
    throw new Error(`No managed Paperclip issue found for ${ticketKey}. Start the ticket first.`);
  }
  const companyId = provisioned.loaded.state.companyId;
  if (!companyId) {
    throw new Error("Harness company is missing.");
  }
  const pullRequestUrl = await syncBuilderPullRequest(provisioned, group);
  const taskPacket = await buildRoleTaskPacket({
    provisioned,
    specPacket: group.specPacket,
    role: "spot-check",
    summary: `Operator spot-check for ${ticketKey}. Re-run the local flow and collect fresh artifacts.`,
    prUrl: pullRequestUrl,
  });
  const existing = findSubtaskByRole(group, "spot-check");
  const spotCheckIssue = existing
    ? await provisioned.paperclip.updateIssue(existing.id, {
        title: `Operator Spot Check ${ticketKey}`,
        description: renderTaskPacket(taskPacket),
        parentId: group.parent.id,
        projectId: provisioned.loaded.state.projectId,
        status: "todo",
        priority: "medium",
      })
    : await provisioned.paperclip.createIssue(companyId, {
        title: `Operator Spot Check ${ticketKey}`,
        description: renderTaskPacket(taskPacket),
        parentId: group.parent.id,
        projectId: provisioned.loaded.state.projectId,
        status: "todo",
        priority: "medium",
      });
  await runArtifactWalkthrough({
    artifactDir: taskPacket.artifactDir,
    packet: taskPacket,
    sessionName: `operator-${ticketKey.toLowerCase()}`,
  });
  await writeReviewFile(taskPacket.artifactDir, [
    `# Operator Spot Check`,
    ``,
    `Ticket: ${ticketKey}`,
    `Artifact dir: ${taskPacket.artifactDir}`,
    `Status: complete`,
  ]);
  const artifactCheck = await checkArtifacts(taskPacket.artifactDir, taskPacket.requiredArtifacts);
  await provisioned.paperclip.updateIssue(spotCheckIssue.id, {
    status: artifactCheck.missingArtifacts.length === 0 ? "done" : "blocked",
    comment: trimPrompt(`
Spot check completed for ${ticketKey}.

- Artifact dir: ${taskPacket.artifactDir}
- Missing artifacts: ${artifactCheck.missingArtifacts.length === 0 ? "none" : artifactCheck.missingArtifacts.join(", ")}
    `),
  });
  runtime.log(`Spot-check artifacts: ${taskPacket.artifactDir}`);
}

async function mutateAllAgents(
  provisioned: ProvisionResult,
  mutation: "pause" | "resume" | "terminate",
) {
  const agentIds = Object.values(provisioned.loaded.state.agentIds ?? {}).filter(Boolean);
  for (const agentId of agentIds) {
    if (mutation === "pause") {
      await provisioned.paperclip.pauseAgent(agentId);
    }
    if (mutation === "resume") {
      await provisioned.paperclip.resumeAgent(agentId);
    }
    if (mutation === "terminate") {
      await provisioned.paperclip.terminateAgent(agentId);
    }
  }
}

export async function operatorPauseAll(configPath: string | undefined, runtime: RuntimeEnv) {
  const provisioned = await ensureProvisioned(configPath);
  await mutateAllAgents(provisioned, "pause");
  const nextState = { ...provisioned.loaded.state, paused: true };
  await saveHarnessState(provisioned.loaded, nextState);
  runtime.log("Paused all harness agents.");
}

export async function operatorResumeAll(configPath: string | undefined, runtime: RuntimeEnv) {
  const provisioned = await ensureProvisioned(configPath);
  await mutateAllAgents(provisioned, "resume");
  const nextState = { ...provisioned.loaded.state, paused: false };
  await saveHarnessState(provisioned.loaded, nextState);
  runtime.log("Resumed all harness agents.");
}

export async function operatorStopAll(configPath: string | undefined, runtime: RuntimeEnv) {
  const provisioned = await ensureProvisioned(configPath);
  const companyId = provisioned.loaded.state.companyId;
  if (!companyId) {
    throw new Error("Harness is not provisioned.");
  }
  const liveRuns = await provisioned.paperclip.listLiveRuns(companyId);
  for (const run of liveRuns) {
    await provisioned.paperclip.cancelRun(run.id).catch(() => undefined);
  }
  // Preserve the configured local agent roster so the harness can be resumed after a stop.
  await mutateAllAgents(provisioned, "pause");
  const nextState = { ...provisioned.loaded.state, paused: true };
  await saveHarnessState(provisioned.loaded, nextState);
  runtime.log(`Stopped all harness agents and cancelled ${liveRuns.length} live runs.`);
}
