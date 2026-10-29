/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

async function mountOutputs() {
  const navigate = vi.fn();
  const artifacts = Array.from({ length: 5 }, (_, id) => ({
    id: String(id),
    title: `Demo ${id}.md`,
    type: "document",
    download: { mode: "bytes" as const },
  }));
  const value: ChatDetailsProps = {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", sessionId: "session-1", kind: "direct" },
    desktopPresentation: { peopleLabel: "", outputsLabel: "Outputs", subagentsWorkingLabel: "" },
    desktopDisclosures: { expanded: { outputs: true }, onExpandedChange: vi.fn() },
    outputs: {
      artifacts,
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
  await waitForSolid(() => expect(element.querySelector(".chat-outputs__view-all")).not.toBeNull());
  const button = element.querySelector<HTMLButtonElement>(".chat-outputs__view-all")!;
  return { element, button, value, navigate, artifacts };
}

it("opens Files through the current callback when Outputs refreshes before the visible button settles", async () => {
  const { element, button, value, navigate, artifacts } = await mountOutputs();
  button.click();
  expect(navigate).toHaveBeenCalledOnce();
  navigate.mockClear();
  const refreshed = vi.fn();
  const pending = Promise.withResolvers<void>();
  onTestFinished(() => pending.resolve());
  element.props = {
    ...value,
    outputs: {
      ...value.outputs!,
      artifactRead: {
        items: artifacts,
        resolved: true,
        loaded: false,
        loading: true,
        error: null,
        readResult: pending.promise,
      },
      onViewAll: refreshed,
    },
  };
  expect(element.querySelector(".chat-outputs__view-all")).toBe(button);
  button.click();
  expect(refreshed).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

it.each(["session", "agent", "incarnation", "visibility"] as const)(
  "rejects a visible View all callback after its %s changes",
  async (retirement) => {
    const { element, button, value, navigate } = await mountOutputs();
    if (retirement === "visibility") {
      element.presented = false;
    } else {
      const patch = {
        session: { sessionKey: "agent:main:other" },
        agent: { currentAgentId: "other" },
        incarnation: { selectedSession: { ...value.selectedSession!, sessionId: "session-2" } },
      }[retirement];
      element.props = { ...value, outputs: { ...value.outputs! }, ...patch };
    }
    button.click();
    expect(navigate).not.toHaveBeenCalled();
  },
);
