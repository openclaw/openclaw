/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { AppSidebarOwner, type AppSidebarElement } from "./app-sidebar.tsx";
import { PersonalSessionGroups } from "./personal-session-groups.tsx";

it.for(["Move down", "Remove personal group"])(
  "uses complete authored membership for cached group action: %s",
  async (action) => {
    const context = createContext(
      createGateway(createTestGatewayClient(async () => ({}))),
      createSessions("main", []),
    );
    const first = {
      id: "first",
      label: "Focus",
      sessionKeys: ["agent:main:public", "agent:main:unresolved"],
    };
    const second = { id: "second", label: "Later", sessionKeys: [] };
    const newest = { id: "newest", label: "Newer layout", sessionKeys: ["agent:main:new"] };
    context.navigation.update({ personalSessionGroups: [first, second, newest] });
    const host = new AppSidebarOwner(
      { dashboards: null, loadMoreDashboards() {} },
      context,
      document.createElement("openclaw-app-sidebar") as AppSidebarElement,
    );
    host.sidebarSnapshot = {
      ...sidebarBootSnapshot(null),
      personalGroups: [{ ...first, sessionKeys: ["agent:main:public"] }, second],
    };
    const provider = createSolidApplicationContextProvider(context);
    const view = mountSolid(() => <PersonalSessionGroups host={host} />, {
      wrapper: provider.wrapper,
    });
    view.getByRole("button", { name: /^Options for personal group Focus$/ }).click();
    await waitForSolid(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === action,
    );
    expect(item).toBeDefined();
    item!.click();
    const expected = action === "Move down" ? [second, first, newest] : [second, newest];
    expect(context.navigation.snapshot.personalSessionGroups).toEqual(expected);
    await waitForSolid(() =>
      expect(
        [...view.container.querySelectorAll("[data-personal-session-group]")].map((group) =>
          group.getAttribute("data-personal-session-group"),
        ),
      ).toEqual(expected.map((group) => group.id)),
    );
    host.sidebarSnapshot = {
      ...sidebarBootSnapshot(null),
      personalGroups: [{ id: "new-scope", label: "Other workspace", sessionKeys: [] }],
    };
    context.navigation.update({ personalSessionGroups: [] });
    await waitForSolid(() =>
      expect(
        [...view.container.querySelectorAll("[data-personal-session-group]")].map((group) =>
          group.getAttribute("data-personal-session-group"),
        ),
      ).toEqual(["new-scope"]),
    );
  },
);
