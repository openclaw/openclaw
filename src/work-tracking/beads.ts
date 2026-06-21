// Optional Beads CLI bridge for durable orchestration work graphs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BeadsIssueMetadataValue = string | number | boolean | null;
export type BeadsIssueMetadata = Record<string, BeadsIssueMetadataValue>;

export type BeadsIssue = {
  id: string;
  title: string;
  status?: string;
  issue_type?: string;
  type?: string;
  priority?: number | string;
  assignee?: string;
  owner?: string;
  external_ref?: string;
  labels?: string[];
  metadata?: BeadsIssueMetadata;
  created_at?: string;
  updated_at?: string;
};

export type BeadsCommandResult = {
  stdout: string;
  stderr: string;
};

export type BeadsCommandRunner = (args: readonly string[]) => Promise<BeadsCommandResult>;

export type BeadsClient = {
  status: () => Promise<unknown>;
  ready: (params?: {
    limit?: number;
    labels?: readonly string[];
    metadata?: BeadsIssueMetadata;
  }) => Promise<BeadsIssue[]>;
  list: (params?: {
    limit?: number;
    labels?: readonly string[];
    metadata?: BeadsIssueMetadata;
    status?: string;
    all?: boolean;
  }) => Promise<BeadsIssue[]>;
  show: (id: string) => Promise<BeadsIssue | BeadsIssue[]>;
  create: (params: {
    title: string;
    type?: string;
    priority?: string;
    labels?: readonly string[];
    metadata?: BeadsIssueMetadata;
    description?: string;
    externalRef?: string;
    dependencies?: readonly string[];
  }) => Promise<BeadsIssue>;
  claim: (id: string) => Promise<BeadsIssue>;
  close: (id: string, params?: { reason?: string }) => Promise<unknown>;
};

export class BeadsUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BeadsUnavailableError";
  }
}

export function parseBeadsMetadataFilterValue(value: string): BeadsIssueMetadataValue {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  const numeric = Number(trimmed);
  return trimmed !== "" && Number.isFinite(numeric) ? numeric : value;
}

export function parseBeadsMetadataFilters(
  filters: readonly string[] | undefined,
): BeadsIssueMetadata {
  const metadata: BeadsIssueMetadata = {};
  for (const filter of filters ?? []) {
    const separator = filter.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid Beads metadata filter "${filter}". Use key=value.`);
    }
    const key = filter.slice(0, separator).trim();
    if (!key) {
      throw new Error(`Invalid Beads metadata filter "${filter}". Use key=value.`);
    }
    metadata[key] = parseBeadsMetadataFilterValue(filter.slice(separator + 1));
  }
  return metadata;
}

export function formatMissingBeadsMessage(): string {
  return [
    "No Beads workspace is available.",
    "Install Beads (`npm install -g @beads/bd@1.0.4`) and run `bd init` in this repository, or set BEADS_DIR to an existing .beads directory.",
  ].join(" ");
}

function parseJsonOutput<T>(result: BeadsCommandResult): T {
  const text = result.stdout.trim();
  if (!text) {
    return null as T;
  }
  return JSON.parse(text) as T;
}

function appendRepeated(args: string[], flag: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    args.push(flag, value);
  }
}

function appendMetadataFilters(args: string[], metadata: BeadsIssueMetadata | undefined): void {
  for (const [key, value] of Object.entries(metadata ?? {})) {
    args.push("--metadata-field", `${key}=${String(value)}`);
  }
}

function buildMetadata(params: {
  metadata?: BeadsIssueMetadata;
  repo?: string;
  branch?: string;
  prUrl?: string;
  owner?: string;
  nextAction?: string;
}): BeadsIssueMetadata {
  return {
    ...(params.metadata ?? {}),
    ...(params.repo ? { repo: params.repo } : {}),
    ...(params.branch ? { branch: params.branch } : {}),
    ...(params.prUrl ? { prUrl: params.prUrl } : {}),
    ...(params.owner ? { owner: params.owner } : {}),
    ...(params.nextAction ? { nextAction: params.nextAction } : {}),
  };
}

export function buildOpenClawWorkMetadata(params: {
  metadata?: BeadsIssueMetadata;
  repo?: string;
  branch?: string;
  prUrl?: string;
  owner?: string;
  nextAction?: string;
}): BeadsIssueMetadata {
  return buildMetadata(params);
}

async function runBdProcess(args: readonly string[]): Promise<BeadsCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bd", [...args], {
      maxBuffer: 1024 * 1024 * 16,
    });
    return {
      stdout: String(stdout),
      stderr: String(stderr),
    };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "ENOENT") {
      throw new BeadsUnavailableError(formatMissingBeadsMessage(), { cause: err });
    }
    const stderr = String((err as { stderr?: unknown })?.stderr ?? "").trim();
    if (/no beads database found|No active beads workspace found/iu.test(stderr)) {
      throw new BeadsUnavailableError(formatMissingBeadsMessage(), { cause: err });
    }
    throw err;
  }
}

function normalizeIssueList(value: unknown): BeadsIssue[] {
  if (Array.isArray(value)) {
    return value as BeadsIssue[];
  }
  if (value && typeof value === "object" && Array.isArray((value as { issues?: unknown }).issues)) {
    return (value as { issues: BeadsIssue[] }).issues;
  }
  return [];
}

export function createBeadsClient(runner: BeadsCommandRunner = runBdProcess): BeadsClient {
  const runJson = async <T>(args: readonly string[]): Promise<T> =>
    parseJsonOutput<T>(await runner([...args, "--json"]));

  return {
    status: () => runJson<unknown>(["status"]),
    async ready(params = {}) {
      const args = ["ready", "--limit", String(params.limit ?? 100)];
      appendRepeated(args, "--label", params.labels);
      appendMetadataFilters(args, params.metadata);
      return normalizeIssueList(await runJson<unknown>(args));
    },
    async list(params = {}) {
      const args = ["list", "--limit", String(params.limit ?? 50)];
      if (params.all) {
        args.push("--all");
      }
      if (params.status) {
        args.push("--status", params.status);
      }
      appendRepeated(args, "--label", params.labels);
      appendMetadataFilters(args, params.metadata);
      return normalizeIssueList(await runJson<unknown>(args));
    },
    show: (id) => runJson<BeadsIssue | BeadsIssue[]>(["show", id]),
    create(params) {
      const args = [
        "create",
        params.title,
        "--type",
        params.type ?? "task",
        "--priority",
        params.priority ?? "P2",
      ];
      appendRepeated(args, "--labels", params.labels);
      if (params.description) {
        args.push("--description", params.description);
      }
      if (params.externalRef) {
        args.push("--external-ref", params.externalRef);
      }
      if (params.dependencies && params.dependencies.length > 0) {
        args.push("--deps", params.dependencies.join(","));
      }
      if (params.metadata && Object.keys(params.metadata).length > 0) {
        args.push("--metadata", JSON.stringify(params.metadata));
      }
      return runJson<BeadsIssue>(args);
    },
    claim: (id) => runJson<BeadsIssue>(["update", id, "--claim"]),
    close(id, params = {}) {
      const args = ["close", id];
      if (params.reason) {
        args.push("--reason", params.reason);
      }
      return runJson<unknown>(args);
    },
  };
}
