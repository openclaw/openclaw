// List the message reactions recorded for one session through the canonical
// `session.reactions.list` gateway RPC. A failed call must exit nonzero so
// automation cannot mistake a silent no-op for an empty reaction set.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type ReactionIdentity = {
  id?: string;
  label?: string;
};

type MessageReactionSummary = {
  emoji?: string;
  count?: number;
  identities?: ReactionIdentity[];
};

type SessionReactionsResult = {
  sessionId?: string;
  reactions?: Record<string, MessageReactionSummary[]>;
};

function describeReactionRow(messageId: string, reactions: MessageReactionSummary[]): string {
  const parts = reactions.map((reaction) => {
    const emoji = sanitizeTerminalText(reaction.emoji ?? "");
    const count = typeof reaction.count === "number" ? reaction.count : 0;
    return `${emoji} ×${count}`;
  });
  return `${sanitizeTerminalText(messageId)}\t${parts.join("  ")}`;
}

export async function sessionsReactionsCommand(
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

  let result: SessionReactionsResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionReactionsResult>(
      "session.reactions.list",
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
      runtime.error(`Failed to list reactions: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }

  const reactions = result.reactions ?? {};
  const messageIds = Object.keys(reactions);
  if (messageIds.length === 0) {
    runtime.log(`No reactions recorded for session ${sanitizeTerminalText(opts.key)}.`);
    return;
  }
  for (const messageId of messageIds) {
    const rows = reactions[messageId] ?? [];
    if (rows.length === 0) {
      continue;
    }
    runtime.log(describeReactionRow(messageId, rows));
  }
}
