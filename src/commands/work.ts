// Human-facing durable work graph commands backed by Beads.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  buildOpenClawWorkMetadata,
  createBeadsClient,
  formatMissingBeadsMessage,
  parseBeadsMetadataFilters,
  type BeadsClient,
  type BeadsIssue,
  type BeadsIssueMetadata,
} from "../work-tracking/beads.js";

type WorkCommandContext = {
  client?: BeadsClient;
};

type WorkCreateOptions = {
  title: string;
  json?: boolean;
  type?: string;
  priority?: string;
  label?: string[];
  metadata?: string[];
  repo?: string;
  branch?: string;
  prUrl?: string;
  owner?: string;
  nextAction?: string;
  description?: string;
  externalRef?: string;
  dependsOn?: string[];
  discoveredFrom?: string[];
};

type WorkListOptions = {
  json?: boolean;
  limit?: number;
  label?: string[];
  metadata?: string[];
  status?: string;
  all?: boolean;
};

const info = theme.info;

function safe(value: string): string {
  return sanitizeTerminalText(value);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}...`;
}

function getClient(context: WorkCommandContext | undefined): BeadsClient {
  return context?.client ?? createBeadsClient();
}

function parseWorkMetadata(opts: {
  metadata?: string[];
  repo?: string;
  branch?: string;
  prUrl?: string;
  owner?: string;
  nextAction?: string;
}): BeadsIssueMetadata {
  return buildOpenClawWorkMetadata({
    metadata: parseBeadsMetadataFilters(opts.metadata),
    repo: opts.repo,
    branch: opts.branch,
    prUrl: opts.prUrl,
    owner: opts.owner,
    nextAction: opts.nextAction,
  });
}

function normalizeDependency(type: string, id: string): string {
  return id.includes(":") ? id : `${type}:${id}`;
}

function parseDependencies(opts: WorkCreateOptions): string[] {
  return [
    ...(opts.dependsOn ?? []).map((id) => normalizeDependency("blocks", id)),
    ...(opts.discoveredFrom ?? []).map((id) => normalizeDependency("discovered-from", id)),
  ];
}

function issueType(issue: BeadsIssue): string {
  return issue.issue_type ?? issue.type ?? "task";
}

function issueStatus(issue: BeadsIssue): string {
  return issue.status ?? "open";
}

function formatIssueRows(issues: readonly BeadsIssue[]): string[] {
  const header = ["ID".padEnd(18), "Status".padEnd(12), "Type".padEnd(12), "P", "Title"].join(" ");
  const lines = [theme.heading(header)];
  for (const issue of issues) {
    lines.push(
      [
        truncate(safe(issue.id), 18).padEnd(18),
        truncate(safe(issueStatus(issue)), 12).padEnd(12),
        truncate(safe(issueType(issue)), 12).padEnd(12),
        String(issue.priority ?? "").padEnd(1),
        truncate(safe(issue.title), 90),
      ].join(" "),
    );
  }
  return lines;
}

function formatIssueDetail(issue: BeadsIssue): string[] {
  const metadata = Object.entries(issue.metadata ?? {});
  return [
    info(`Bead: ${issue.id}`),
    `Title: ${safe(issue.title)}`,
    `Status: ${safe(issueStatus(issue))}`,
    `Type: ${safe(issueType(issue))}`,
    `Priority: ${String(issue.priority ?? "n/a")}`,
    ...(issue.external_ref ? [`External ref: ${safe(issue.external_ref)}`] : []),
    ...(metadata.length > 0
      ? ["Metadata:", ...metadata.map(([key, value]) => `  ${safe(key)}=${safe(String(value))}`)]
      : []),
  ];
}

async function runBeadsCommand<T>(
  runtime: RuntimeEnv,
  action: () => Promise<T>,
): Promise<T | null> {
  try {
    return await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(message || formatMissingBeadsMessage());
    runtime.exit(1);
    return null;
  }
}

/** Show the Beads workspace status used by OpenClaw work tracking. */
export async function workStatusCommand(
  opts: { json?: boolean },
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const result = await runBeadsCommand(runtime, () => getClient(context).status());
  if (result === null) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(info("Beads work graph is available."));
}

/** List ready Beads work that is not blocked by active dependencies. */
export async function workReadyCommand(
  opts: WorkListOptions,
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const metadata = parseBeadsMetadataFilters(opts.metadata);
  const issues = await runBeadsCommand(runtime, () =>
    getClient(context).ready({
      limit: opts.limit,
      labels: opts.label,
      metadata,
    }),
  );
  if (!issues) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { count: issues.length, work: issues });
    return;
  }
  runtime.log(info(`Ready work: ${issues.length}`));
  for (const line of formatIssueRows(issues)) {
    runtime.log(line);
  }
}

/** List Beads work items for OpenClaw/Klaw orchestration. */
export async function workListCommand(
  opts: WorkListOptions,
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const metadata = parseBeadsMetadataFilters(opts.metadata);
  const issues = await runBeadsCommand(runtime, () =>
    getClient(context).list({
      limit: opts.limit,
      labels: opts.label,
      metadata,
      status: opts.status,
      all: opts.all,
    }),
  );
  if (!issues) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { count: issues.length, work: issues });
    return;
  }
  runtime.log(info(`Work items: ${issues.length}`));
  for (const line of formatIssueRows(issues)) {
    runtime.log(line);
  }
}

/** Create a Beads work item with OpenClaw orchestration metadata. */
export async function workCreateCommand(
  opts: WorkCreateOptions,
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const metadata = parseWorkMetadata(opts);
  const issue = await runBeadsCommand(runtime, () =>
    getClient(context).create({
      title: opts.title,
      type: opts.type,
      priority: opts.priority,
      labels: opts.label,
      metadata,
      description: opts.description,
      externalRef: opts.externalRef ?? opts.prUrl,
      dependencies: parseDependencies(opts),
    }),
  );
  if (!issue) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { work: issue });
    return;
  }
  runtime.log(info(`Created Beads work item: ${issue.id}`));
  runtime.log(`Next: ${formatCliCommand(`openclaw work claim ${issue.id}`)}`);
}

/** Claim a Beads work item for the current actor. */
export async function workClaimCommand(
  opts: { id: string; json?: boolean },
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const issue = await runBeadsCommand(runtime, () => getClient(context).claim(opts.id));
  if (!issue) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { work: issue });
    return;
  }
  runtime.log(info(`Claimed Beads work item: ${issue.id}`));
}

/** Show one Beads work item. */
export async function workShowCommand(
  opts: { id: string; json?: boolean },
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const result = await runBeadsCommand(runtime, () => getClient(context).show(opts.id));
  if (!result) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { work: result });
    return;
  }
  const issue = Array.isArray(result) ? result[0] : result;
  if (!issue) {
    runtime.error(`Beads work item not found: ${opts.id}`);
    runtime.exit(1);
    return;
  }
  for (const line of formatIssueDetail(issue)) {
    runtime.log(line);
  }
}

/** Close one Beads work item after the durable coordination work is done. */
export async function workCloseCommand(
  opts: { id: string; reason?: string; json?: boolean },
  runtime: RuntimeEnv,
  context?: WorkCommandContext,
): Promise<void> {
  const result = await runBeadsCommand(runtime, () =>
    getClient(context).close(opts.id, { reason: opts.reason }),
  );
  if (result === null) {
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { result });
    return;
  }
  runtime.log(info(`Closed Beads work item: ${opts.id}`));
}
