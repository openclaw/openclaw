/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";

it("publishes placement status without admitting another transcript message", async () => {
  const sessionKey = "agent:main:placement-publication";
  const mounted = createMountedPanes([
    {
      key: sessionKey,
      sessionId: "placement-session",
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
    },
  ]);
  let status: ApplicationPlacementStartupStatus | null = null;
  const listeners = new Set<() => void>();
  Object.assign(mounted.context, {
    placementStartup: {
      ...mounted.context.placementStartup,
      get: () => status,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const pane = mounted.mount(sessionKey);
  await refreshPane(pane);
  await waitForSolid(() => expect(pane.querySelector("textarea")).not.toBeNull());
  expect(pane.state.chatMessages).toEqual([]);

  status = {
    sessionKey,
    phase: "failed",
    startedAt: 1,
    error: "Synthetic placement startup failed",
  };
  listeners.forEach((listener) => listener());
  flush();
  expect(pane.textContent).toContain("Synthetic placement startup failed");
  expect(pane.state.chatMessages).toEqual([]);

  status = null;
  listeners.forEach((listener) => listener());
  flush();
  expect(pane.textContent).not.toContain("Synthetic placement startup failed");
});
