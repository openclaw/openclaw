import { describe, expect, it } from "vitest";
import { summarizeLogTail } from "./gateway.js";

describe("summarizeLogTail", () => {
  it("marks permanent OAuth refresh failures as reauth-required", () => {
    const lines = summarizeLogTail([
      "[openai-codex] Token refresh failed: 401 {",
      '"error":{"code":"invalid_grant","message":"Session invalidated due to signing in again"}',
      "}",
    ]);

    expect(lines).toEqual(["[openai-codex] token refresh 401 invalid_grant · re-auth required"]);
  });

  it("filters routine ws chatter and timestamped plain text", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [ws] ⇄ res ✓ 200 ok",
      "2026-04-15T12:00:01.000Z this is plain assistant text",
      "2026-04-15T12:00:02.000Z [diagnostic] queue depth high",
    ]);

    expect(lines).toEqual(["2026-04-15T12:00:02.000Z [diagnostic] queue depth high"]);
  });

  it("filters tool/web_fetch wrapper residue together", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [tools] web_fetch failed: 404",
      "  - Begin external-content",
      "  - Source: Web Fetch",
      "  - 404: Not Found",
      "2026-04-15T12:00:02.000Z [tasks/executor] retrying background task",
    ]);

    expect(lines).toEqual(["2026-04-15T12:00:02.000Z [tasks/executor] retrying background task"]);
  });

  it("filters routine feishu and exec chatter but keeps structured operational logs", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [feishu] received message chat_id=abc",
      "2026-04-15T12:00:01.000Z [exec] elevated command: openclaw status --all",
      "2026-04-15T12:00:02.000Z [agent/embedded] token refresh 401 invalid_grant · re-auth required",
    ]);

    expect(lines).toEqual([
      "2026-04-15T12:00:02.000Z [agent/embedded] token refresh 401 invalid_grant · re-auth required",
    ]);
  });

  it("groups repeated lane wait diagnostics by lane", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [diagnostic] lane wait exceeded: lane=session:agent:avery waitedMs=113000 queueAhead=0",
      "2026-04-15T12:00:01.000Z [diagnostic] lane wait exceeded: lane=session:agent:avery waitedMs=113200 queueAhead=0",
    ]);

    expect(lines).toEqual([
      "[diagnostic] lane wait exceeded: session:agent:avery · last 113s · queueAhead 0 ×2",
    ]);
  });

  it("groups repeated best-effort subagent-end and detached-flow failures", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [agents/subagent-registry] context-engine onSubagentEnded failed (best-effort)",
      "2026-04-15T12:00:01.000Z [agents/subagent-registry] context-engine onSubagentEnded failed (best-effort)",
      "2026-04-15T12:00:02.000Z [tasks/executor] Failed to create one-task flow for detached run",
      "2026-04-15T12:00:03.000Z [tasks/executor] Failed to create one-task flow for detached run",
    ]);

    expect(lines).toEqual([
      "[agents/subagent-registry] context-engine onSubagentEnded failed (best-effort) ×2",
      "[tasks/executor] Failed to create one-task flow for detached run ×2",
    ]);
  });

  it("groups repeated context-overflow diagnostics by session and provider even when field order varies", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [agent/embedded] [context-overflow-diag] sessionKey=agent:avery:feishu:direct provider=openai-codex/gpt-5.4 source=provider messages=193 diagId=one",
      "2026-04-15T12:00:01.000Z [agent/embedded] [context-overflow-diag] provider=openai-codex/gpt-5.4 diagId=two messages=193 sessionKey=agent:avery:feishu:direct source=provider",
    ]);

    expect(lines).toEqual([
      "[agent/embedded] context overflow: agent:avery:feishu:direct · provider openai-codex/gpt-5.4 · last messages 193 ×2",
    ]);
  });

  it("groups repeated auto-compaction attempts by provider", () => {
    const lines = summarizeLogTail([
      "2026-04-15T12:00:00.000Z [agent/embedded] context overflow detected (attempt 1/3); attempting auto-compaction for openai-codex/gpt-5.4",
      "2026-04-15T12:00:01.000Z [agent/embedded] context overflow detected (attempt 2/3); attempting auto-compaction for openai-codex/gpt-5.4",
    ]);

    expect(lines).toEqual([
      "[agent/embedded] context overflow auto-compaction attempted (openai-codex/gpt-5.4) ×2",
    ]);
  });
});
