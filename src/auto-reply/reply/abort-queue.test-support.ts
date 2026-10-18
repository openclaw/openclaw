import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import type { FollowupRun } from "./queue/types.js";

export function enqueueAbortFollowupRun(params: {
  root: string;
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
}) {
  const followupRun: FollowupRun = {
    prompt: "queued",
    enqueuedAt: Date.now(),
    run: {
      agentId: resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey }),
      agentDir: path.join(params.root, "agent"),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageProvider: "telegram",
      agentAccountId: "acct",
      sessionFile: path.join(params.root, "session.jsonl"),
      workspaceDir: path.join(params.root, "workspace"),
      config: params.cfg,
      provider: "anthropic",
      model: "claude-opus-4-6",
      timeoutMs: 1000,
      blockReplyBreak: "text_end",
    },
  };
  enqueueFollowupRun(
    params.sessionKey,
    followupRun,
    { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
    "none",
  );
}
