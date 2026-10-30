/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatWelcome } from "./chat-welcome.tsx";

type OperatorAuth = { role?: string; scopes?: readonly string[] } | null;

function renderSuggestions(operatorAuth: OperatorAuth, onDraftChange = vi.fn(), onSend = vi.fn()) {
  const container = document.createElement("div");
  mountSolid(
    () => (
      <ChatWelcome
        assistantName="Val"
        assistantAvatar={null}
        operatorAuth={operatorAuth}
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    ),
    { container },
  );
  return [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__suggestion")];
}

describe("chat welcome starter prompts", () => {
  afterEach(cleanupSolid);

  it.each([
    ["missing auth", null],
    ["write grant", { role: "operator", scopes: ["operator.write"] }],
    ["admin grant", { role: "operator", scopes: ["operator.admin"] }],
  ] as const)("keeps operator prompts for %s", (_name, operatorAuth) => {
    expect(renderSuggestions(operatorAuth).map((button) => button.textContent?.trim())).toEqual([
      "What can you do?",
      "Summarize my recent sessions",
      "Help me configure a channel",
      "Check system health",
    ]);
  });

  it("offers session-scoped guests prompts within their own sessions", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const buttons = renderSuggestions(
      { role: "operator", scopes: ["operator.sessions.write"] },
      onDraftChange,
      onSend,
    );

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "What can you do?",
      "Tour OpenClaw's code and docs",
      "Investigate an issue in a sandbox",
      "Fix a bug and open a draft PR",
    ]);
    buttons[3]?.click();
    expect(onDraftChange).toHaveBeenCalledWith("Fix a bug and open a draft PR");
    expect(onSend).toHaveBeenCalledOnce();
  });
});
