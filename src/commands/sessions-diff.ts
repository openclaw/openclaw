// A missing, stopped, or still-computing checkout diff must exit nonzero (or say so
// plainly) so automation cannot read "no output" as "the session changed nothing".
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

const DIFF_SCOPES = ["all", "uncommitted", "commit"] as const;

type SessionsDiffScope = (typeof DIFF_SCOPES)[number];
type SessionsDiffFile = {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  untracked?: boolean;
  patch?: string;
  truncated?: boolean;
};

type SessionsDiffCommit = { sha: string; subject: string };

type SessionsDiffResult = {
  sessionKey?: string;
  root?: string;
  branch?: string;
  baseRef?: string;
  aheadCount?: number;
  commits?: SessionsDiffCommit[];
  mergeBase?: SessionsDiffCommit;
  files?: SessionsDiffFile[];
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  computing?: boolean;
  unavailableReason?: "unknown_session" | "not_git" | "unknown_commit" | "workspace_stopped";
};

function parseScope(raw: string | undefined): SessionsDiffScope | undefined {
  const scope = raw?.trim();
  if (!scope) {
    return undefined;
  }
  switch (scope) {
    case "all":
    case "uncommitted":
    case "commit":
      return scope;
    default:
      throw new Error(`--scope must be one of ${DIFF_SCOPES.join(", ")}.`);
  }
}

const UNAVAILABLE_MESSAGES: Record<
  NonNullable<SessionsDiffResult["unavailableReason"]>,
  (key: string) => string
> = {
  unknown_session: (key) =>
    `Session ${key} was not found. Run openclaw sessions list to pick a stored session.`,
  not_git: (key) =>
    `Session ${key} has no git checkout on this Gateway, so there is nothing to diff.`,
  unknown_commit: (key) => `The requested --commit is not in session ${key}'s checkout history.`,
  workspace_stopped: (key) =>
    `Session ${key}'s workspace is stopped. Start it on the Gateway and retry.`,
};

function describeUnavailable(
  reason: NonNullable<SessionsDiffResult["unavailableReason"]>,
  key: string,
): string {
  return UNAVAILABLE_MESSAGES[reason](key);
}

function describeFile(file: SessionsDiffFile): string {
  const path = sanitizeTerminalText(file.path);
  const rename = file.oldPath ? `${sanitizeTerminalText(file.oldPath)} → ` : "";
  const size = file.binary ? "binary" : `+${file.additions} -${file.deletions}`;
  const notes = [file.untracked ? "untracked" : "", file.truncated ? "patch truncated" : ""]
    .filter(Boolean)
    .join(", ");
  return `  ${sanitizeTerminalText(file.status)} ${rename}${path}  ${size}${notes ? `  (${notes})` : ""}`;
}

function describeTarget(result: SessionsDiffResult, fallbackKey: string): string {
  const key = sanitizeTerminalText(result.sessionKey ?? fallbackKey);
  if (!result.branch) {
    return key;
  }
  const base = sanitizeTerminalText(result.baseRef ?? "HEAD");
  const ahead =
    typeof result.aheadCount === "number"
      ? `, ${result.aheadCount} commit${result.aheadCount === 1 ? "" : "s"} ahead`
      : "";
  return `${key} on ${sanitizeTerminalText(result.branch)} (base ${base}${ahead})`;
}

export function describeSessionsDiff(result: SessionsDiffResult, fallbackKey: string): string {
  const lines = [`Diff for ${describeTarget(result, fallbackKey)}`];
  const commits = result.commits ?? [];
  if (commits.length > 0) {
    lines.push("", `Commits (${commits.length}):`);
    for (const commit of commits) {
      lines.push(`  ${sanitizeTerminalText(commit.sha)} ${sanitizeTerminalText(commit.subject)}`);
    }
  }
  const files = result.files ?? [];
  lines.push("", files.length > 0 ? `Files (${files.length}):` : "No changed files.");
  for (const file of files) {
    lines.push(describeFile(file));
  }
  const count = files.length;
  lines.push(
    "",
    `${count} file${count === 1 ? "" : "s"} changed, +${result.additions ?? 0} -${result.deletions ?? 0}.`,
  );
  if (result.truncated) {
    lines.push("The file list is truncated; rerun with --json for the complete response.");
  }
  return lines.join("\n");
}

export async function sessionsDiffCommand(
  opts: {
    key: string;
    agent?: string;
    scope?: string;
    commit?: string;
    summary?: boolean;
    timeout?: string;
    url?: string;
    token?: string;
    password?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const agent = opts.agent?.trim();
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  const scope = parseScope(opts.scope);
  const commit = opts.commit?.trim() || undefined;
  if (commit && scope !== "commit") {
    throw new Error("--commit requires --scope commit.");
  }
  if (scope === "commit" && !commit) {
    throw new Error("--scope commit requires --commit <sha>.");
  }

  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    // A shared checkout read can legitimately take longer than the default call.
    timeout: opts.timeout ?? null,
    json: opts.json,
  };
  const params = {
    sessionKey: opts.key,
    ...(agent ? { agentId: agent } : {}),
    ...(scope ? { scope } : {}),
    ...(commit ? { commit } : {}),
    ...(opts.summary ? { summaryOnly: true } : {}),
  };

  let result: SessionsDiffResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionsDiffResult>(
      "sessions.diff",
      rpcOpts,
      params,
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), key: opts.key });
    } else {
      runtime.error(`Diff failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  const unavailable = result?.unavailableReason;
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    if (unavailable) {
      runtime.exit(1);
    }
    return;
  }
  if (unavailable) {
    runtime.error(describeUnavailable(unavailable, sanitizeTerminalText(opts.key)));
    runtime.exit(1);
    return;
  }
  // An empty file list here means "not measured yet", not "no changes".
  if (result?.computing === true) {
    runtime.log(
      `Diff for ${sanitizeTerminalText(opts.key)} is still computing on the Gateway; rerun in a moment.`,
    );
    return;
  }

  runtime.log(describeSessionsDiff(result ?? {}, opts.key));
}
