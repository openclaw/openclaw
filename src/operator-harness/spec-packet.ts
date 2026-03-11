import fs from "node:fs/promises";
import path from "node:path";
import { extractNotionUrlsFromText } from "./linear-client.js";
import type {
  ArtifactCheckResult,
  BrowserWalkthroughStep,
  HarnessConfig,
  LinearIssueRef,
  ManagedIssueGroup,
  ManagedIssueSummary,
  NotionPageEntry,
  OperatorReviewRole,
  OperatorRole,
  SpecPacket,
  TaskPacket,
} from "./types.js";

const SPEC_TAG = "openclaw-operator-spec";
const TASK_TAG = "openclaw-operator-task";

export const DEFAULT_ARTIFACTS = [
  "before.png",
  "after.png",
  "annotated.png",
  "walkthrough.webm",
  "serve.log",
  "review.md",
];

const MOORE_BASS_PILOT_CONTRACT = {
  startupCommand:
    "if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi; pnpm ui:dev --host 127.0.0.1 --port 4173",
  healthcheckUrl: "http://127.0.0.1:4173/pilot/",
  browserWalkthrough: [
    { action: "open", value: "http://127.0.0.1:4173/pilot/" },
    { action: "wait_load" },
    { action: "assert_text", target: "[data-testid='pilot-home-title']", value: "Pilot Home" },
    {
      action: "assert_text",
      target: "[data-testid='pilot-dashboard-card-source-health-title']",
      value: "Source pack health",
    },
    { action: "click", target: "[data-testid='pilot-home-new-project']" },
    { action: "wait_load" },
    {
      action: "fill",
      target: "[data-testid='pilot-project-parcel-input']",
      value: "APN 123-456-789",
    },
    {
      action: "fill",
      target: "[data-testid='pilot-project-address-input']",
      value: "100 Main St, Austin, TX",
    },
    {
      action: "fill",
      target: "[data-testid='pilot-project-scope-input']",
      value: "Civil entitlement due diligence",
    },
    { action: "click", target: "[data-testid='pilot-project-create']" },
    {
      action: "assert_text",
      target: "[data-testid='pilot-project-summary-title']",
      value: "Pilot project created",
    },
    {
      action: "assert_text",
      target: "[data-testid='pilot-project-launch-chat']",
      value: "Launch project workspace",
    },
  ] satisfies BrowserWalkthroughStep[],
};

function extractTaggedJson<T>(text: string | null | undefined, tag: string) {
  if (!text) {
    return null;
  }
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
  if (!match?.[1]) {
    return null;
  }
  return JSON.parse(match[1]) as T;
}

function trimSection(text: string) {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

function buildTaskScriptCommand(taskPacketPath: string | undefined, scriptRelativePath: string) {
  if (!taskPacketPath) {
    return undefined;
  }
  const normalizedPacketPath = taskPacketPath.split(path.sep).join("/");
  return `node --import tsx ${scriptRelativePath} --task ${normalizedPacketPath}`;
}

function determineContractId(input: {
  issue: LinearIssueRef;
  notionEntries: NotionPageEntry[];
  config: HarnessConfig;
}) {
  const haystack = [
    input.issue.title,
    input.issue.description,
    input.issue.projectName ?? "",
    ...input.notionEntries.map((entry) => `${entry.title}\n${entry.summary}\n${entry.markdown}`),
    ...(input.config.notion.baselineUrls ?? []),
  ]
    .join("\n")
    .toLowerCase();
  if (
    haystack.includes("moore bass") ||
    haystack.includes("construction knowledge platform storyboard hub") ||
    haystack.includes("/pilot")
  ) {
    return "moore-bass-pilot";
  }
  return "generic";
}

export function extractAcceptanceCriteria(description: string) {
  const lines = description.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /acceptance criteria/i.test(line));
  if (headingIndex >= 0) {
    const collected: string[] = [];
    for (const line of lines.slice(headingIndex + 1)) {
      if (/^#{1,6}\s/.test(line.trim())) {
        break;
      }
      const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (bulletMatch?.[1]) {
        collected.push(bulletMatch[1].trim());
      }
    }
    if (collected.length > 0) {
      return collected;
    }
  }
  return lines
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .slice(0, 6);
}

export function determineReviewRoles(input: {
  issue: LinearIssueRef;
  overrideRoles?: OperatorReviewRole[];
  config: HarnessConfig;
}) {
  if (input.overrideRoles && input.overrideRoles.length > 0) {
    return Array.from(new Set(input.overrideRoles));
  }
  const haystack =
    `${input.issue.title}\n${input.issue.description}\n${input.issue.labels.join(" ")}`.toLowerCase();
  const roles = new Set<OperatorReviewRole>(input.config.reviewRules.default);
  if (
    /\b(ui|ux|design|storyboard|visual|browser|screenshot|frontend|responsive)\b/.test(haystack)
  ) {
    for (const role of input.config.reviewRules.ui) {
      roles.add(role);
    }
  }
  if (/\b(ai|llm|model|prompt|rag|embedding|completion)\b/.test(haystack)) {
    for (const role of input.config.reviewRules.ai) {
      roles.add(role);
    }
  }
  return Array.from(roles);
}

export function buildSpecPacket(input: {
  config: HarnessConfig;
  issue: LinearIssueRef;
  notionEntries: NotionPageEntry[];
}) {
  const override = input.config.ticketOverrides?.[input.issue.identifier];
  const contractId = determineContractId(input);
  const notionUrls = Array.from(
    new Set([
      ...(input.config.notion.baselineUrls ?? []),
      ...(override?.notionUrls ?? []),
      ...extractNotionUrlsFromText(input.issue.description),
      ...input.notionEntries.map((entry) => entry.url),
    ]),
  );
  const storyboardHubUrls = Array.from(
    new Set(
      input.notionEntries
        .filter((entry) => /storyboard hub/i.test(entry.title))
        .map((entry) => entry.url),
    ),
  );
  const acceptanceCriteria =
    override?.acceptanceCriteria ?? extractAcceptanceCriteria(input.issue.description);
  if (acceptanceCriteria.length === 0) {
    throw new Error(`No acceptance criteria found for ${input.issue.identifier}`);
  }
  const defaultContract =
    contractId === "moore-bass-pilot"
      ? MOORE_BASS_PILOT_CONTRACT
      : {
          startupCommand: input.config.workspace.defaultStartupCommand ?? "",
          healthcheckUrl: input.config.workspace.defaultHealthcheckUrl ?? "",
          browserWalkthrough: input.config.workspace.defaultBrowserWalkthrough ?? [],
        };
  const startupCommand = override?.startupCommand ?? defaultContract.startupCommand;
  const healthcheckUrl = override?.healthcheckUrl ?? defaultContract.healthcheckUrl;
  if (!startupCommand.trim()) {
    throw new Error(`No startup command configured for ${input.issue.identifier}`);
  }
  if (!healthcheckUrl.trim()) {
    throw new Error(`No healthcheck URL configured for ${input.issue.identifier}`);
  }
  const browserWalkthrough = override?.browserWalkthrough ?? defaultContract.browserWalkthrough;
  if (browserWalkthrough.length === 0) {
    throw new Error(`No browser walkthrough configured for ${input.issue.identifier}`);
  }
  const summary =
    override?.summary ??
    input.issue.description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ??
    input.issue.title;
  const relevantScreens = Array.from(
    new Set([
      ...(override?.relevantScreens ?? []),
      ...input.notionEntries.flatMap((entry) => entry.relevantScreens),
    ]),
  );
  const requiredReviewRoles = determineReviewRoles({
    issue: input.issue,
    overrideRoles: override?.reviewRoles,
    config: input.config,
  });
  const requiredArtifacts = override?.requiredArtifacts ?? DEFAULT_ARTIFACTS;
  return {
    kind: "parent",
    contractId,
    externalTicketId: input.issue.identifier,
    upstreamIssueId: input.issue.id,
    title: input.issue.title,
    summary,
    upstreamUrl: input.issue.url,
    notionUrls,
    storyboardHubUrls,
    acceptanceCriteria,
    startupCommand,
    healthcheckUrl,
    browserWalkthrough,
    requiredArtifacts,
    requiredReviewRoles,
    relevantScreens,
    notionPages: input.notionEntries.map((entry) => ({
      id: entry.id,
      url: entry.url,
      title: entry.title,
      summary: entry.summary,
    })),
    repoKey: input.config.workspace.repoKey,
    repoName: input.config.workspace.repoName,
    repoCwd: input.config.workspace.repoCwd,
    repoUrl: input.config.workspace.repoUrl ?? null,
    baseBranch: input.config.workspace.baseBranch,
    environmentPrerequisites: override?.environmentPrerequisites ?? [],
  } satisfies SpecPacket;
}

export function renderSpecPacket(specPacket: SpecPacket) {
  return trimSection(`
<${SPEC_TAG}>
${JSON.stringify(specPacket, null, 2)}
</${SPEC_TAG}>

## Summary
${specPacket.summary}

## Upstream
- Linear: ${specPacket.upstreamUrl}
${specPacket.notionUrls.map((url) => `- Notion: ${url}`).join("\n")}
${specPacket.storyboardHubUrls.map((url) => `- Storyboard Hub: ${url}`).join("\n")}

## Acceptance Criteria
${specPacket.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

## Startup Contract
- Contract: \`${specPacket.contractId}\`
- Command: \`${specPacket.startupCommand}\`
- Healthcheck: ${specPacket.healthcheckUrl}
- Repo cwd: \`${specPacket.repoCwd}\`
- Base branch: \`${specPacket.baseBranch}\`

## Browser Walkthrough
${specPacket.browserWalkthrough.map((step, index) => `1. ${index + 1}. ${step.action}${step.target ? ` ${step.target}` : ""}${step.value ? ` => ${step.value}` : ""}`).join("\n")}

## Review Matrix
- Required review roles: ${specPacket.requiredReviewRoles.join(", ")}
- Required artifacts: ${specPacket.requiredArtifacts.join(", ")}

## Notion Context
${specPacket.notionPages.length === 0 ? "- No Notion pages resolved." : specPacket.notionPages.map((page) => `- ${page.title}: ${page.url}`).join("\n")}
  `);
}

export function buildTaskPacket(input: {
  role: OperatorRole;
  specPacket: SpecPacket;
  artifactDir: string;
  repoRelativeArtifactDir: string;
  summary: string;
  branchName: string;
  baseBranch: string;
  gitRemoteName: string;
  prRequired: boolean;
  prTitle: string;
  prBodyPath: string;
  prUrl?: string | null;
  specPacketPath?: string;
  taskPacketPath?: string;
  repoCwd?: string;
  startupCommand?: string;
  healthcheckUrl?: string;
  browserWalkthrough?: BrowserWalkthroughStep[];
}) {
  return {
    kind: "task",
    contractId: input.specPacket.contractId,
    externalTicketId: input.specPacket.externalTicketId,
    role: input.role,
    summary: input.summary,
    upstreamUrl: input.specPacket.upstreamUrl,
    startupCommand: input.startupCommand ?? input.specPacket.startupCommand,
    healthcheckUrl: input.healthcheckUrl ?? input.specPacket.healthcheckUrl,
    browserWalkthrough: input.browserWalkthrough ?? input.specPacket.browserWalkthrough,
    requiredArtifacts: input.specPacket.requiredArtifacts,
    artifactDir: input.artifactDir,
    repoRelativeArtifactDir: input.repoRelativeArtifactDir,
    repoCwd: input.repoCwd ?? input.specPacket.repoCwd,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    gitRemoteName: input.gitRemoteName,
    prRequired: input.prRequired,
    prTitle: input.prTitle,
    prBodyPath: input.prBodyPath,
    ...(input.taskPacketPath
      ? {
          validationCommand: buildTaskScriptCommand(
            input.taskPacketPath,
            "operator-harness/scripts/run-artifact-walkthrough.ts",
          ),
          prSyncCommand: buildTaskScriptCommand(
            input.taskPacketPath,
            "operator-harness/scripts/sync-pr.ts",
          ),
        }
      : {}),
    ...(input.taskPacketPath
      ? {
          finalizeCommand: buildTaskScriptCommand(
            input.taskPacketPath,
            "operator-harness/scripts/finalize-ticket.ts",
          ),
        }
      : {}),
    ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    ...(input.specPacketPath ? { specPacketPath: input.specPacketPath } : {}),
    ...(input.taskPacketPath ? { taskPacketPath: input.taskPacketPath } : {}),
    notionUrls: input.specPacket.notionUrls,
    acceptanceCriteria: input.specPacket.acceptanceCriteria,
    relevantScreens: input.specPacket.relevantScreens,
  } satisfies TaskPacket;
}

export function renderTaskPacket(taskPacket: TaskPacket) {
  return trimSection(`
<${TASK_TAG}>
${JSON.stringify(taskPacket, null, 2)}
</${TASK_TAG}>

## Task
${taskPacket.summary}

## Required Evidence
- Artifact directory: \`${taskPacket.artifactDir}\`
- Repo evidence path: \`${taskPacket.repoRelativeArtifactDir}\`
- Required artifacts: ${taskPacket.requiredArtifacts.join(", ")}
- Startup command: \`${taskPacket.startupCommand}\`
- Healthcheck URL: ${taskPacket.healthcheckUrl}
- Validation command: ${taskPacket.validationCommand ? `\`${taskPacket.validationCommand}\`` : "not set"}
- PR sync command: ${taskPacket.prSyncCommand ? `\`${taskPacket.prSyncCommand}\`` : "not set"}
- Finalize command: ${taskPacket.finalizeCommand ? `\`${taskPacket.finalizeCommand}\`` : "not set"}
- Branch: \`${taskPacket.branchName}\`
- Base branch: \`${taskPacket.baseBranch}\`
- Pull request required: ${taskPacket.prRequired ? "yes" : "no"}
${taskPacket.prUrl ? `- PR: ${taskPacket.prUrl}` : ""}
${taskPacket.taskPacketPath ? `- Task packet: \`${taskPacket.taskPacketPath}\`` : ""}
${taskPacket.specPacketPath ? `- Parent packet: \`${taskPacket.specPacketPath}\`` : ""}

## Browser Walkthrough
${taskPacket.browserWalkthrough.map((step, index) => `1. ${index + 1}. ${step.action}${step.target ? ` ${step.target}` : ""}${step.value ? ` => ${step.value}` : ""}`).join("\n")}
  `);
}

export function parseSpecPacket(description: string | null | undefined) {
  return extractTaggedJson<SpecPacket>(description, SPEC_TAG);
}

export function parseTaskPacket(description: string | null | undefined) {
  return extractTaggedJson<TaskPacket>(description, TASK_TAG);
}

export async function checkArtifacts(artifactDir: string, requiredArtifacts: string[]) {
  const presentArtifacts: string[] = [];
  const missingArtifacts: string[] = [];
  for (const artifact of requiredArtifacts) {
    const filePath = path.join(artifactDir, artifact);
    const exists = await fs
      .stat(filePath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (exists) {
      presentArtifacts.push(artifact);
    } else {
      missingArtifacts.push(artifact);
    }
  }
  return {
    artifactDir,
    presentArtifacts,
    missingArtifacts,
  } satisfies ArtifactCheckResult;
}

export function groupManagedIssues(issues: ManagedIssueSummary[]) {
  const parents = new Map<string, ManagedIssueGroup>();
  for (const issue of issues) {
    const specPacket = parseSpecPacket(issue.description);
    if (specPacket?.kind === "parent") {
      parents.set(issue.id, {
        parent: issue,
        specPacket,
        subtasks: [],
      });
    }
  }

  for (const issue of issues) {
    if (!issue.parentId) {
      continue;
    }
    const group = parents.get(issue.parentId);
    if (!group) {
      continue;
    }
    group.subtasks.push({
      ...issue,
      taskPacket: parseTaskPacket(issue.description),
    });
  }

  return Array.from(parents.values());
}

export function findSubtaskByRole(group: ManagedIssueGroup, role: OperatorRole) {
  return group.subtasks.find((task) => task.taskPacket?.role === role) ?? null;
}

export function isManagedIssueBlocked(group: ManagedIssueGroup) {
  return (
    group.parent.status === "blocked" || group.subtasks.some((task) => task.status === "blocked")
  );
}

export function isManagedIssueInReview(group: ManagedIssueGroup) {
  return (
    group.parent.status === "in_review" ||
    group.subtasks.some((task) => task.taskPacket?.role !== "builder" && task.status !== "done")
  );
}
