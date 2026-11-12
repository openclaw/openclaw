/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
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
      "Tour OpenClaw’s code and docs",
      "Investigate an issue in a sandbox",
      "Fix a bug and open a draft PR",
    ]);
    buttons[3]?.click();
    expect(onDraftChange).toHaveBeenCalledWith("Fix a bug and open a draft PR");
    expect(onSend).toHaveBeenCalledOnce();
  });
});

it("uses selected-agent copy and keeps custom starters beside recents without sending on mount", () => {
  const onDraftChange = vi.fn();
  const onSend = vi.fn();
  const [agentId, selectAgent] = createSignal("briefing");
  const agents = [
    {
      id: "briefing",
      description: "Follows your repositories.",
      conversationStarters: ["Set up a repository", "Show my tracked projects"],
    },
    {
      id: "research",
      description: "Researches questions.",
      conversationStarters: ["Explore a topic"],
    },
    { id: "plain" },
  ];
  const view = mountSolid(() => (
    <ChatWelcome
      currentAgentId={agentId()}
      {...agents.find((agent) => agent.id === agentId())}
      assistantName="Assistant"
      assistantAvatar={null}
      hint="Choose where to work."
      preparedRecents={[
        {
          key: "agent:briefing:dashboard:recent",
          name: "Recent work",
          subtitle: undefined,
          updatedAt: 0,
        },
      ]}
      onDraftChange={onDraftChange}
      onSend={onSend}
    />
  ));
  expect(view.container.textContent).toContain("Follows your repositories.");
  expect(view.container.textContent).toContain("Choose where to work.");
  expect(view.container.textContent).toContain("Recent work");
  const suggestions = () => [
    ...view.container.querySelectorAll<HTMLButtonElement>(".agent-chat__suggestion"),
  ];
  expect(suggestions().map((button) => button.textContent)).toEqual([
    "Set up a repository",
    "Show my tracked projects",
  ]);
  expect(onSend).not.toHaveBeenCalled();
  suggestions()[1]!.click();
  expect(onDraftChange).toHaveBeenCalledWith("Show my tracked projects");
  expect(onSend).toHaveBeenCalledOnce();
  selectAgent("research");
  flush();
  expect(view.container.textContent).not.toContain("Follows your repositories.");
  expect(suggestions().map((button) => button.textContent)).toEqual(["Explore a topic"]);
  selectAgent("plain");
  flush();
  expect(view.container.textContent).not.toContain("Researches questions.");
  expect(suggestions()).toHaveLength(0);
});

it.each(["incognito", "model setup"])("preserves %s behavior with agent metadata", (variant) => {
  const view = mountSolid(() => (
    <ChatWelcome
      currentAgentId="briefing"
      description="Tracks repositories."
      conversationStarters={["Brief me"]}
      assistantName="Briefing"
      assistantAvatar={null}
      hideSecondaryContent={variant === "incognito"}
      modelSetupRequired={variant === "model setup"}
      preparedRecents={[
        { key: "recent", name: "Private recent chat", subtitle: undefined, updatedAt: 0 },
      ]}
      onDraftChange={() => {}}
      onSend={() => {}}
    />
  ));
  expect(view.container.textContent).not.toContain("Private recent chat");
  expect(view.container.querySelectorAll(".agent-chat__suggestion")).toHaveLength(
    variant === "incognito" ? 1 : 0,
  );
  expect(view.container.textContent?.includes("Tracks repositories.")).toBe(
    variant === "incognito",
  );
});
