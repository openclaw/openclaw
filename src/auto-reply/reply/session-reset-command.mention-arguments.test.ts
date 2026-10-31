import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionResetCommand } from "./session-reset-command.js";

describe("session command mention arguments", () => {
  it("preserves configured mention text inside group command arguments", () => {
    const body = "/acp spawn codex --cwd /Users/me/norma/projects/linkauto-app";
    const cfg = {
      messages: { groupChat: { mentionPatterns: ["Norma"] } },
    } satisfies OpenClawConfig;

    const result = resolveSessionResetCommand({
      commandText: body,
      rawText: body,
      resetTriggers: ["/new", "/reset"],
      ctx: { Body: body, RawBody: body, ChatType: "group" },
      cfg,
      agentId: "main",
      isGroup: true,
      resetAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe(body);
  });
});
