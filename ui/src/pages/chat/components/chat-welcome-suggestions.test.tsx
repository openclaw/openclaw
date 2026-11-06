/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { WelcomeSuggestionAuth } from "./chat-welcome.ts";
import { ChatWelcome } from "./chat-welcome.tsx";

type OperatorAuth = WelcomeSuggestionAuth;

function renderSuggestions(
  operatorAuth: OperatorAuth,
  onDraftChange = vi.fn(),
  onSend = vi.fn(),
  onFocusComposer = vi.fn(),
) {
  const container = document.createElement("div");
  mountSolid(
    () => (
      <ChatWelcome
        assistantName="Val"
        assistantAvatar={null}
        operatorAuth={operatorAuth}
        onDraftChange={onDraftChange}
        onSend={onSend}
        onFocusComposer={onFocusComposer}
      />
    ),
    { container },
  );
  return [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__suggestion")];
}

describe("chat welcome starter prompts", () => {
  afterEach(cleanupSolid);

  it("offers restricted guests three editable starting points without sending", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const onFocusComposer = vi.fn();
    const buttons = renderSuggestions(
      { role: "operator", scopes: [], sessionCap: "view" },
      onDraftChange,
      onSend,
      onFocusComposer,
    );
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Help me get started",
      "Explore OpenClaw",
      "Start a task",
    ]);
    expect(buttons[0]?.classList.contains("agent-chat__guest-start-primary")).toBe(true);
    for (const button of buttons) {
      button.click();
    }
    expect(onDraftChange.mock.calls.map(([draft]) => draft)).toEqual([
      expect.stringContaining("Ask what I want to accomplish"),
      expect.stringContaining("with my current access"),
      expect.stringContaining("Ask me what I want to accomplish"),
    ]);
    expect(onFocusComposer).toHaveBeenCalledTimes(3);
    expect(onSend).not.toHaveBeenCalled();
  });

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
      "Tour OpenClaw’s code and docs",
      "Investigate an issue in a sandbox",
      "Fix a bug and open a draft PR",
    ]);
    buttons[3]?.click();
    expect(onDraftChange).toHaveBeenCalledWith("Fix a bug and open a draft PR");
    expect(onSend).toHaveBeenCalledOnce();
  });
});
