import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

it.each([false, true])(
  "restores a loaded Files catalog after remount (search open: %s)",
  async (searchInitiallyOpen) => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(1200, 800);
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:0;top:0;width:440px;height:320px";
    document.body.append(container);
    onTestFinished(() => container.remove());
    let savedTop = 0;
    const [searchOpen, setSearchOpen] = createSignal(false);
    const workspace = (): SessionWorkspaceProps => ({
      sessionKey: "main",
      presentation: "desktop",
      loading: false,
      error: null,
      activeId: null,
      filter: "all",
      browserPath: "",
      browserSearch: "",
      navigation: {
        browserPath: "",
        browserSearch: "",
        filter: "all",
        expandedPaths: [""],
        searchOpen: searchOpen(),
        sessionExpanded: true,
        treeVisible: true,
        treeScroll: savedTop,
        sessionScroll: 0,
      },
      list: {
        sessionKey: "main",
        root: "/workspace",
        files: [],
        browser: {
          path: "",
          entries: Array.from({ length: 50 }, (_, index) => ({
            path: "file-" + String(index).padStart(2, "0") + ".ts",
            name: "file-" + String(index).padStart(2, "0") + ".ts",
            kind: "file",
          })),
        },
      },
      onBrowsePath: () => {},
      onRetry: () => {},
      onOpenFile: () => {},
      onSearch: () => {},
      onSearchOpenChange: setSearchOpen,
      onSetFilter: () => {},
      onOpenArtifact: () => {},
      onNavigationScroll: (area, top) => {
        if (area === "tree") {
          savedTop = top;
        }
      },
    });
    const mount = () =>
      mountSolid(() => <SessionWorkspaceRail workspace={workspace()} />, { container });
    let view = mount();
    onTestFinished(() => view.unmount());
    const scroll = () =>
      container.querySelector<HTMLElement>(".workspace-desktop__project-scroll")!;
    await waitForSolid(() => expect(scroll().scrollHeight).toBeGreaterThan(scroll().clientHeight));
    scroll().scrollTop = 180;
    await waitForSolid(() => expect(savedTop).toBe(180));
    view.unmount();
    setSearchOpen(searchInitiallyOpen);
    flush();
    view = mount();
    if (searchInitiallyOpen) {
      await userEvent.click(view.getByRole("button", { name: "Close file search" }));
    }
    await waitForSolid(() => expect(scroll().scrollHeight).toBeGreaterThan(scroll().clientHeight));
    expect(scroll().scrollTop).toBe(180);
  },
);
