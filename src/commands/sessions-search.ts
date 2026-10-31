// Search past transcript text through the Gateway's canonical search owner; this
// command only shapes output and exit codes, like the other gateway-backed verbs.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
export const SESSIONS_SEARCH_MAX_LIMIT = 25;
const SNIPPET_MAX_CHARS = 240;

type SessionsSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "user" | "assistant";
  timestamp: number;
  snippet: string;
  score: number;
};

type SessionsSearchResult = {
  results?: SessionsSearchHit[];
  indexing?: boolean;
  archivedTranscriptsExcluded?: number;
  truncated?: boolean;
};

function describeSnippet(hit: SessionsSearchHit): string {
  const oneLine = hit.snippet.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_MAX_CHARS ? `${oneLine.slice(0, SNIPPET_MAX_CHARS)}…` : oneLine;
}

export function renderSessionsSearch(result: SessionsSearchResult, query: string): string {
  const lines: string[] = [];
  const hits = result.results ?? [];
  if (hits.length === 0) {
    lines.push(`No transcript matches for "${sanitizeTerminalText(query)}".`);
  } else {
    lines.push(`${theme.heading("Transcript matches")} ${theme.muted(`(${hits.length})`)}`);
    lines.push(
      renderTable({
        width: getTerminalTableWidth(),
        columns: [
          { key: "When", header: "When", minWidth: 20 },
          { key: "Session", header: "Session", minWidth: 14, flex: true },
          { key: "Role", header: "Role", minWidth: 9 },
          { key: "Score", header: "Score", minWidth: 6 },
          { key: "Snippet", header: "Snippet", minWidth: 24, flex: true },
        ],
        rows: hits.map((hit) => ({
          When: new Date(hit.timestamp).toISOString(),
          Session: sanitizeTerminalText(hit.sessionKey).slice(0, 60),
          Role: hit.role,
          Score: hit.score.toFixed(3),
          Snippet: describeSnippet(hit),
        })),
      }).trimEnd(),
    );
  }
  if (result.indexing === true) {
    lines.push(
      theme.muted(
        "The transcript index is still reconciling; results may be incomplete. Rerun in a moment.",
      ),
    );
  }
  if (result.truncated === true) {
    lines.push(theme.muted("More matches exist; raise --limit or narrow the query."));
  }
  if (
    typeof result.archivedTranscriptsExcluded === "number" &&
    result.archivedTranscriptsExcluded > 0
  ) {
    lines.push(
      theme.muted(
        `${result.archivedTranscriptsExcluded} archived transcript(s) excluded from this search.`,
      ),
    );
  }
  return lines.join("\n");
}

export async function sessionsSearchCommand(
  opts: {
    query: string;
    agent?: string;
    keys?: string[];
    limit?: number;
    activeMinutes?: number;
    timeout?: string;
    url?: string;
    token?: string;
    password?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const query = opts.query.trim();
  if (!query) {
    throw new Error("Query must not be empty.");
  }
  const agent = opts.agent?.trim();
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  const keys = opts.keys?.map((key) => key.trim()).filter((key) => key.length > 0);
  const limit = Math.min(
    Math.max(opts.limit ?? SESSIONS_SEARCH_DEFAULT_LIMIT, 1),
    SESSIONS_SEARCH_MAX_LIMIT,
  );
  const activeMinutes =
    opts.activeMinutes !== undefined ? Math.max(opts.activeMinutes, 1) : undefined;

  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout ?? null,
    json: opts.json,
  };
  const params = {
    query,
    ...(agent ? { agentId: agent } : {}),
    ...(keys && keys.length > 0 ? { sessionKeys: keys } : {}),
    ...(limit !== SESSIONS_SEARCH_DEFAULT_LIMIT ? { limit } : {}),
    ...(activeMinutes !== undefined ? { scope: { activeMinutes } } : {}),
  };

  let result: SessionsSearchResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionsSearchResult>(
      "sessions.search",
      rpcOpts,
      params,
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), query });
    } else {
      runtime.error(`Search failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(renderSessionsSearch(result ?? {}, query));
}
