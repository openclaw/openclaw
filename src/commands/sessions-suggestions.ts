// List the pending composer suggestions recorded for one session through the
// canonical `session.suggestions.list` gateway RPC. The RPC already exists and
// the web composer consumes it; operators running from a terminal had no way to
// read the same set. A failed call must exit nonzero so automation cannot mistake
// a silent no-op for an empty suggestion list.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SuggestionAuthor = {
  type?: string;
  id?: string;
  label?: string;
};

type SessionSuggestion = {
  id?: string;
  state?: string;
  text?: string;
  createdAt?: number;
  author?: SuggestionAuthor;
};

type SessionSuggestionsResult = {
  suggestions?: SessionSuggestion[];
  role?: string;
};

function describeAuthor(author: SuggestionAuthor | undefined): string {
  // The canonical actor projection always carries `type`; `label`/`id` are optional.
  const label = author?.label?.trim() || author?.id?.trim() || author?.type?.trim();
  return sanitizeTerminalText(label ?? "unknown");
}

function describeCreatedAt(createdAt: number | undefined): string {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) {
    return "unknown";
  }
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function describeSuggestionRow(suggestion: SessionSuggestion): string {
  const id = sanitizeTerminalText(suggestion.id ?? "unknown");
  const state = sanitizeTerminalText(suggestion.state ?? "unknown");
  const author = describeAuthor(suggestion.author);
  const createdAt = describeCreatedAt(suggestion.createdAt);
  const text = sanitizeTerminalText((suggestion.text ?? "").replace(/\s+/gu, " ").trim());
  return `${id}\t${state}\t${author}\t${createdAt}\t${text}`;
}

export async function sessionsSuggestionsCommand(
  opts: {
    key: string;
    agent?: string;
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
  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    json: opts.json,
  };
  const params = {
    sessionKey: opts.key,
    ...(agent ? { agentId: agent } : {}),
  };

  let result: SessionSuggestionsResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionSuggestionsResult>(
      "session.suggestions.list",
      rpcOpts,
      params,
      {
        defaultTimeoutMs: 30_000,
        // Inspection must stay credential-neutral: without this the client can
        // mint a device identity and cache or clear tokens, which both mutates
        // local credentials and fails against a read-only credential store.
        sharedStateMode: "read-only",
      },
    );
  } catch (error) {
    rethrowExpectedCliError(error);
    const message = formatErrorMessage(error);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), key: opts.key });
    } else {
      runtime.error(`Failed to list session suggestions: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }

  const suggestions = result.suggestions ?? [];
  if (suggestions.length === 0) {
    runtime.log(`No suggestions recorded for session ${sanitizeTerminalText(opts.key)}.`);
    return;
  }
  for (const suggestion of suggestions) {
    runtime.log(describeSuggestionRow(suggestion));
  }
}
