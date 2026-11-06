import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createDetailsBrowserFixture,
  detailsFixtureProps,
} from "./chat-details.browser.test-support.ts";
const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const node of mounted.splice(0)) {
    node.remove();
  }
});
const details = (allowed = true) =>
  detailsFixtureProps({
    progressCard: undefined,
    detailsWorkspace: undefined,
    desktopPresentation: {
      peopleLabel: "People",
      outputsLabel: "Outputs",
      subagentsWorkingLabel: "Working",
    },
    onOpenProcesses: allowed ? vi.fn() : undefined,
    cachedDetails: {
      locale: "en",
      processes: { total: 1, rows: [{ processId: "build", instanceId: "build-1", name: "Build" }] },
    },
  });
it("reserves admitted cached Processes through pending to ready", async () => {
  await page.viewport(1700, 900);
  const view = await createDetailsBrowserFixture(details(), mounted, 1320, false, "desktop", true);
  expect(getComputedStyle(view.conversation).right).toBe("313px");
  const before = view.conversation.getBoundingClientRect();
  view.update({ contentPending: false });
  await waitForSolid(() =>
    expect(view.panel.querySelector('[data-details-group="processes"]')).not.toBeNull(),
  );
  const after = view.conversation.getBoundingClientRect();
  expect([after.x, after.y, after.width, after.height]).toEqual([
    before.x,
    before.y,
    before.width,
    before.height,
  ]);
  expect(getComputedStyle(view.conversation).right).toBe("313px");
});
it("does not admit cached Processes without its callback and mounts the actual empty body", async () => {
  await page.viewport(1700, 900);
  const view = await createDetailsBrowserFixture(
    details(false),
    mounted,
    1320,
    false,
    "desktop",
    true,
  );
  expect(getComputedStyle(view.conversation).right).toBe("0px");
  view.update({ contentPending: false });
  await waitForSolid(() =>
    expect(view.panel.querySelector(".chat-details-desktop-body")).not.toBeNull(),
  );
  expect(view.panel.querySelector('[data-details-group="processes"]')).toBeNull();
  expect(getComputedStyle(view.conversation).right).toBe("0px");
});
it.each(["empty", "access"] as const)(
  "retires a cached process preview after an authoritative %s result",
  async (result) => {
    await page.viewport(1700, 900);
    const response = createDeferred<unknown>();
    const request = createGatewayRequestMock();
    request.mockReturnValue(response.promise);
    const { gateway } = createApplicationGateway({
      ...createApplicationGateway().gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      sessionKey: "agent:main:details",
      assistantAgentId: "main",
      hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
    });
    const provider = createSolidApplicationContextProvider(
      createContext(gateway, createSessions("main", [])),
    );
    onTestFinished(disposeSidebarContextLifecycles);
    const view = await createDetailsBrowserFixture(
      details(),
      mounted,
      1320,
      false,
      "desktop",
      false,
      provider.wrapper,
    );
    await waitForSolid(() => {
      expect(view.panel.querySelector('[data-details-group="processes"]')).not.toBeNull();
      expect(request.mock.calls.some(([method]) => method === "sessions.processes.list")).toBe(
        true,
      );
    });
    if (result === "empty") {
      response.resolve({ sessionId: "parent-session", processes: [], truncated: false });
    } else {
      response.reject(
        new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Not allowed" }),
      );
    }
    await waitForSolid(() => {
      expect(view.panel.querySelector('[data-details-group="processes"]')).toBeNull();
      expect(getComputedStyle(view.conversation).right).toBe("0px");
    });
  },
);
