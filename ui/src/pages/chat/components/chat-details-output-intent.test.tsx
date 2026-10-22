/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

async function mountOutputs() {
  const navigate = vi.fn();
  const value: ChatDetailsProps = {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", sessionId: "session-1", kind: "direct" },
    desktopPresentation: {
      peopleLabel: "People",
      outputsLabel: "Outputs",
      subagentsWorkingLabel: "Working",
    },
    desktopDisclosures: { expanded: { outputs: true }, onExpandedChange: vi.fn() },
    outputs: {
      artifacts: Array.from({ length: 5 }, (_, id) => ({
        id: String(id),
        title: `Demo ${id}.md`,
        type: "document",
        download: { mode: "bytes" as const },
      })),
      artifactsError: null,
      dashboard: null,
      dashboardError: null,
      onOpenArtifact: vi.fn(),
      onViewAll: navigate,
      renderArtifactIcon: () => null,
      renderViewAllIcon: () => null,
    },
  };
  const view = mountSolid(() => <ChatDetailsSession props={value} presented desktop />);
  const element = view.container.querySelector("openclaw-chat-details-session")!;
  await element.updateComplete;
  await waitForSolid(() => expect(element.querySelector(".chat-outputs__view-all")).not.toBeNull());
  const button = element.querySelector<HTMLButtonElement>(".chat-outputs__view-all")!;
  return { element, button, value, navigate };
}

it("opens Files through the current callback when Outputs refreshes before the visible button settles", async () => {
  const { element, button, value, navigate } = await mountOutputs();
  button.click();
  expect(navigate).toHaveBeenCalledOnce();
  navigate.mockClear();
  const refreshed = vi.fn();
  const refresh = createDeferred();
  try {
    element.props = {
      ...value,
      outputs: {
        ...value.outputs!,
        artifactRead: {
          readResult: refresh.promise,
          items: [...value.outputs!.artifacts!],
          resolved: true,
          loaded: false,
          loading: true,
          error: null,
        },
        onViewAll: refreshed,
      },
    };
    expect(element.querySelector(".chat-outputs__view-all")).toBe(button);
    button.click();
    expect(refreshed).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    refresh.resolve();
  }
});

it.each(["session", "agent", "incarnation", "visibility"] as const)(
  "rejects a visible View all callback after its %s changes",
  async (retirement) => {
    const { element, button, value, navigate } = await mountOutputs();
    const retired = { ...value, outputs: { ...value.outputs! } };
    switch (retirement) {
      case "session":
        element.props = { ...retired, sessionKey: "agent:main:other" };
        break;
      case "agent":
        element.props = { ...retired, currentAgentId: "other" };
        break;
      case "incarnation":
        element.props = {
          ...retired,
          selectedSession: { ...value.selectedSession!, sessionId: "session-2" },
        };
        break;
      case "visibility":
        element.presented = false;
        break;
    }
    button.click();
    expect(navigate).not.toHaveBeenCalled();
  },
);
