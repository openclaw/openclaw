import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { SidebarAgentRow } from "./sidebar-agent-row.tsx";
import { Icon } from "./solid/icon.tsx";
import "../test-helpers/load-styles.ts";

function mountRow(attention: boolean) {
  const mounted = mountSolid(() => (
    <div style={{ width: "280px", padding: "8px" }}>
      <SidebarAgentRow
        card={{ id: "main", name: "Molty", avatar: null, textAvatar: "M", href: "#molty" }}
        current
        running={false}
        attention={attention}
        onOpen={() => {}}
        onContextMenu={() => {}}
        actions={
          <button type="button" class="sidebar-agent-roster__action" aria-label="Molty options">
            <Icon name="moreHorizontal" />
            {attention ? (
              <span class="session-unread-dot sidebar-agent-roster__action-unread" />
            ) : null}
          </button>
        }
      />
    </div>
  ));
  const row = mounted.container.querySelector<HTMLElement>(".sidebar-agent-roster__header")!;
  const menuShown = () => {
    const actions = row.querySelector<HTMLElement>(".sidebar-agent-roster__actions")!;
    const icon = row.querySelector<SVGElement>(".sidebar-agent-roster__action svg")!;
    return (
      getComputedStyle(actions).opacity === "1" && getComputedStyle(icon).visibility === "visible"
    );
  };
  return { ...mounted, row, menuShown };
}

it("shows the row's menu while hovered, not after a click", async () => {
  const { row, menuShown, unmount } = mountRow(false);
  try {
    expect(menuShown()).toBe(false);
    await userEvent.hover(row);
    expect(menuShown()).toBe(true);
    await userEvent.click(row.querySelector(".sidebar-agent-roster__row")!);
    await userEvent.unhover(row);
    expect(menuShown()).toBe(false);
  } finally {
    unmount();
  }
});

it("leaves only the dot at rest while other agents have unread conversations", async () => {
  const { row, menuShown, unmount } = mountRow(true);
  try {
    const dot = row.querySelector<HTMLElement>(".sidebar-agent-roster__action-unread")!;
    expect(menuShown()).toBe(false);
    expect(dot.checkVisibility({ opacityProperty: true, visibilityProperty: true })).toBe(true);
    await userEvent.hover(row);
    expect(menuShown()).toBe(true);
  } finally {
    unmount();
  }
});
