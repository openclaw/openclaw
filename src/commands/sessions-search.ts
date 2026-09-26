/**
 * Sessions search command.
 *
 * Wraps the `sessions.search` Gateway RPC behind `openclaw sessions search <query>`
 * so terminal operators can full-text search stored session transcripts without
 * opening the Control UI. The gateway owns visibility/incognito filtering and
 * resolves the searchable store for one agent per call; this command only
 * validates, forwards, and formats results, and propagates a non-zero exit on
 * transport or RPC failures so automation never mistakes a failed lookup for
 * "no matches".
 */
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SessionsSearchCliOptions = {
  query: string;
  agent?: string;
  session?: string[];
  limit?: number;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

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

type SessionsSearchRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

/** Gateway `SessionsSearchParamsSchema` caps limit at 25. */
const MAX_SEARCH_LIMIT = 25;

function formatHit(hit: SessionsSearchHit): string {
  const when = new Date(hit.timestamp).toISOString();
  const header = `${sanitizeTerminalText(hit.sessionKey)}  ${hit.role}  ${when}  score ${hit.score}`;
  const snippet = sanitizeTerminalText(hit.snippet ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return `${header}\n  ${snippet}`;
}

/** Run `openclaw sessions search <query>` against the running gateway. */
export async function sessionsSearchCommand(
  opts: SessionsSearchCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const query = opts.query?.trim();
  if (!query) {
    throw new Error("query must not be blank");
  }
  const agent = opts.agent?.trim();
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  const sessionKeys = (opts.session ?? []).map((key) => key.trim());
  if (sessionKeys.some((key) => key.length === 0)) {
    // An explicitly blank --session is almost always an unset shell variable
    // (`--session "$SESSION_KEY"`). Dropping it would silently widen the
    // search from the intended session to the agent's whole visible store, so
    // reject the selector before the RPC instead of removing the key.
    throw new Error("--session must not be blank; pass an explicit session key or drop the flag");
  }
  if (agent && sessionKeys.length === 0) {
    // Mirrors the gateway rule "agentId requires sessionKeys" with an
    // actionable CLI-level message before paying the RPC round-trip.
    throw new Error(
      "--agent requires at least one --session key; the gateway scopes agent searches to explicit session keys.",
    );
  }
  if (
    opts.limit !== undefined &&
    (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_SEARCH_LIMIT)
  ) {
    throw new Error(`--limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
  }

  const rpcOpts: SessionsSearchRpcOpts = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    // Search is a bounded read. Forward an explicit override, and leave the
    // value undefined when the flag is omitted so the transport applies
    // `defaultTimeoutMs` below; `null` would disable the request deadline
    // outright and let a connected-but-silent gateway stall the command.
    timeout: opts.timeout,
    json: opts.json,
  };
  const params = {
    query,
    ...(agent ? { agentId: agent } : {}),
    ...(sessionKeys.length > 0 ? { sessionKeys } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  };

  let result: SessionsSearchResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionsSearchResult>(
      "sessions.search",
      rpcOpts,
      params,
      { defaultTimeoutMs: 15_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ok: false, query, error: message });
    } else {
      runtime.error(`Search failed: ${message}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }

  const hits = Array.isArray(result?.results) ? result.results : [];
  if (hits.length === 0) {
    runtime.log(`No matching sessions found for "${query}".`);
  } else {
    for (const hit of hits) {
      runtime.log(formatHit(hit));
    }
    runtime.log(`${hits.length} match${hits.length === 1 ? "" : "es"}.`);
  }
  if (result?.indexing === true) {
    runtime.log(
      "note: the transcript search index is still warming up; results may be incomplete.",
    );
  }
  if (
    typeof result?.archivedTranscriptsExcluded === "number" &&
    result.archivedTranscriptsExcluded > 0
  ) {
    runtime.log(`note: ${result.archivedTranscriptsExcluded} archived transcripts excluded.`);
  }
}
