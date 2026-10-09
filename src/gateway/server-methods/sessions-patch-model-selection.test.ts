import { afterEach, expect, it } from "vitest";
import { clearFollowupQueue, getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { refreshSessionPatchQueuedSelection } from "./sessions-patch-model-selection.js";

const sessionKey = "agent:main:direct:model-reset";

afterEach(() => {
  clearFollowupQueue(sessionKey);
});

it("retargets an already queued follow-up after a committed model reset", () => {
  const cfg = { agents: { defaults: { model: "openai/configured" } } };
  const queue = getFollowupQueue(sessionKey, { mode: "followup" });
  queue.items.push({
    prompt: "queued message",
    enqueuedAt: 1,
    run: {
      agentId: "main",
      agentDir: "/fixture/agent",
      sessionId: "session-reset",
      sessionKey,
      sessionFile: "/fixture/session.jsonl",
      workspaceDir: "/fixture/workspace",
      config: cfg,
      provider: "anthropic",
      model: "old-override",
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
    },
  });

  refreshSessionPatchQueuedSelection({
    cfg,
    entry: { sessionId: "session-reset", updatedAt: 2 },
    patch: { key: sessionKey, model: null },
    sessionKey,
    agentId: "main",
  });

  expect(queue.items[0]?.run).toMatchObject({
    provider: "openai",
    model: "configured",
    hasSessionModelOverride: false,
    modelOverrideSource: undefined,
  });
});
