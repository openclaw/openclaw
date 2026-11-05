import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
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
import type { ChatDetailsProps } from "./chat-details-types.ts";
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
const outputs = (knownEmpty = false): NonNullable<ChatDetailsProps["outputs"]> => ({
  artifacts: knownEmpty ? [] : null,
  artifactsError: null,
  dashboard: knownEmpty ? null : undefined,
  dashboardError: null,
  onOpenArtifact: vi.fn(),
  renderArtifactIcon: () => null,
  onViewAll: vi.fn(),
  renderViewAllIcon: () => null,
});
it.each(["cached Outputs", "resolved non-viewer owner"] as const)(
  "preserves %s geometry through pending to ready",
  async (kind) => {
    await page.viewport(1700, 900);
    const request = createGatewayRequestMock();
    const { gateway } = createApplicationGateway({
      ...createApplicationGateway().gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello: gatewayHelloForMethods(["users.self"]),
      selfUser: { id: "native-alex", name: "Alex", identity: { type: "profile", id: "alex" } },
    });
    const context = createContext(gateway, createSessions("main", []));
    onTestFinished(disposeSidebarContextLifecycles);
    const provider = createSolidApplicationContextProvider(context);
    const details: Partial<ChatDetailsProps> =
      kind === "cached Outputs"
        ? { outputs: outputs(), cachedDetails: { locale: "en", outputs: 2 } }
        : {
            selectedSession: {
              key: "agent:main:details",
              kind: "direct",
              owner: {
                actor: { type: "human", id: "blair", identity: { type: "profile", id: "blair" } },
              },
            },
          };
    const view = await createDetailsBrowserFixture(
      detailsFixtureProps({
        progressCard: undefined,
        detailsWorkspace: undefined,
        desktopPresentation: {
          peopleLabel: "People",
          outputsLabel: "Outputs",
          subagentsWorkingLabel: "Working",
        },
        ...details,
      }),
      mounted,
      1320,
      false,
      "desktop",
      true,
      provider.wrapper,
    );
    expect(getComputedStyle(view.conversation).right).toBe("313px");
    const before = view.conversation.getBoundingClientRect();
    view.update({ contentPending: false });
    const section = kind === "cached Outputs" ? "outputs" : "people";
    await waitForSolid(() =>
      expect(view.panel.querySelector(`[data-details-group="${section}"]`)).not.toBeNull(),
    );
    const after = view.conversation.getBoundingClientRect();
    expect([after.x, after.y, after.width, after.height]).toEqual([
      before.x,
      before.y,
      before.width,
      before.height,
    ]);
    expect(getComputedStyle(view.conversation).right).toBe("313px");
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(0);
  },
);
it.each(["known empty live Outputs", "known empty cached Outputs", "unknown self-only"] as const)(
  "does not reserve %s while pending or ready",
  async (kind) => {
    await page.viewport(1700, 900);
    const { gateway } = createApplicationGateway({
      ...createApplicationGateway().gateway.snapshot,
      selfUser: undefined,
    });
    const provider = createSolidApplicationContextProvider(
      createContext(gateway, createSessions("main", [])),
    );
    onTestFinished(disposeSidebarContextLifecycles);
    const details: Partial<ChatDetailsProps> =
      kind === "known empty live Outputs"
        ? { outputs: outputs(true), cachedDetails: { locale: "en", outputs: 2 } }
        : kind === "known empty cached Outputs"
          ? { outputs: outputs(), cachedDetails: { locale: "en", outputs: 0 } }
          : {
              selectedSession: {
                key: "agent:main:details",
                kind: "direct",
                owner: {
                  actor: { type: "human", id: "alex", identity: { type: "profile", id: "alex" } },
                },
              },
            };
    const view = await createDetailsBrowserFixture(
      detailsFixtureProps({
        progressCard: undefined,
        detailsWorkspace: undefined,
        desktopPresentation: {
          peopleLabel: "People",
          outputsLabel: "Outputs",
          subagentsWorkingLabel: "Working",
        },
        ...details,
      }),
      mounted,
      1320,
      false,
      "desktop",
      true,
      provider.wrapper,
    );
    expect(getComputedStyle(view.conversation).right).toBe("0px");
    view.update({ contentPending: false });
    await waitForSolid(() =>
      expect(view.panel.querySelector(".chat-details-desktop-body")).not.toBeNull(),
    );
    expect(getComputedStyle(view.conversation).right).toBe("0px");
    expect(view.panel.hidden).toBe(true);
  },
);
