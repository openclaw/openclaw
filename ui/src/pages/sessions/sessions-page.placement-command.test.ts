/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { SessionMoveTarget } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { showSessionPlacementTargetDialog } from "../../components/session-placement-move-dialog.tsx";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { selectMenuValue, settleSessionMenu } from "../../test-helpers/session-menu.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, createGateway, createRenderedPage } from "./sessions-page.test-support.ts";

vi.mock("../../components/session-placement-move-dialog.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/session-placement-move-dialog.tsx")>()),
  showSessionPlacementTargetDialog: vi.fn(),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.resetAllMocks();
});

it("presents placement work only after choosing a target and keeps rejected writes recoverable", async () => {
  const row: GatewaySessionRow = {
    key: "agent:main:placement",
    sessionId: "placement-generation",
    kind: "direct",
    label: "Placement fixture",
    updatedAt: 1,
    worktree: { id: "placement-worktree", branch: "fixture", repoRoot: "/synthetic/project" },
  };
  const choice = createDeferred<SessionMoveTarget | null>();
  const write = createDeferred<unknown>();
  vi.mocked(showSessionPlacementTargetDialog).mockReturnValue(choice.promise);
  const dispatch = vi.fn(() => write.promise);
  const connection = createGateway(
    createTestGatewayClient((method) => {
      if (method === "sessions.list") {
        return sessionsResult([row], 1);
      }
      if (method === "sessions.dispatch") {
        return dispatch();
      }
      throw new Error(`Unexpected request: ${method}`);
    }),
  );
  const sessions = createTestSessionCapability(connection.gateway);
  const page = await createRenderedPage(
    createContext(connection.gateway, sessions),
    sessionsResult([row], 1),
    "all",
  );
  const working = () =>
    [...page.querySelectorAll('[role="status"]')].some((status) =>
      status.textContent?.includes("Working"),
    );

  try {
    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;
    const menu =
      page.querySelector<HTMLElementTagNameMap["openclaw-session-menu"]>("openclaw-session-menu")!;
    await settleSessionMenu(menu);
    await selectMenuValue(menu, "move-session");
    await waitForFast(() => expect(showSessionPlacementTargetDialog).toHaveBeenCalledOnce());
    expect(dispatch).not.toHaveBeenCalled();
    expect(working()).toBe(false);

    choice.resolve({ kind: "device", deviceId: "synthetic-device" });
    await waitForFast(() => expect(dispatch).toHaveBeenCalledOnce());
    await waitForFast(() => expect(working()).toBe(true));
    write.reject(new Error("Placement unavailable. Choose another worker."));
    await waitForFast(() => expect(working()).toBe(false));
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Placement unavailable. Choose another worker.",
      ),
    );
    expect(page.textContent).toContain("Placement fixture");
  } finally {
    choice.resolve(null);
    write.resolve(undefined);
    page.remove();
    sessions.dispose();
  }
});
