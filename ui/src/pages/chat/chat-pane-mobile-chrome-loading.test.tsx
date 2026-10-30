/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNoopSidebarRegionCallbacks } from "../../test-helpers/sidebar-region-callbacks.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ChatMobileHost } from "./chat-mobile-host.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";

const chrome = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("./chat-mobile-host.runtime.tsx", async (importOriginal) => {
  await chrome.promise;
  return importOriginal<typeof import("./chat-mobile-host.runtime.tsx")>();
});

afterEach(cleanupSolid);

it("reserves the live mobile header and optional grabber while their chunk is pending", async () => {
  const initial: ChatMobileHost = {
    scopeKey: "synthetic-mobile-chrome",
    open: true,
    suspended: false,
    mode: "dock",
    height: undefined,
    reservedHeight: 0,
    destination: { area: "panels" },
    detailsMount: null,
    setDetailsMount: vi.fn(),
    navigate: vi.fn(),
    reveal: vi.fn(),
    close: vi.fn(),
    back: vi.fn(),
    toggleExpanded: vi.fn(),
    resize: vi.fn(),
    keyboardVisible: false,
    onComposerEditingChange: vi.fn(),
  };
  const [host, setHost] = createSignal(initial);
  const mounted = mountSolid(() => (
    <SidebarRegionView
      presentationId="mobile-chrome-loading"
      panelIdPrefix="mobile-chrome-loading"
      availableWidth={390}
      narrow
      mobileHost={host()}
      layout={{ columns: [] }}
      panelDefinitions={[]}
      callbacks={createNoopSidebarRegionCallbacks()}
    />
  ));
  flush();
  const shell = mounted.container.querySelector(".chat-mobile-host")!;
  const header = () => shell.querySelector(".chat-mobile-host__header");
  const grabber = () => shell.querySelector(".chat-mobile-host__grabber");
  expect(header()?.getAttribute("aria-hidden")).toBe("true");
  expect(grabber()?.getAttribute("aria-hidden")).toBe("true");
  expect(shell.querySelector("button")).toBeNull();

  const page = { key: "synthetic-sheet", title: "Details", expandable: false };
  setHost({ ...initial, destination: { area: "details", page } });
  flush();
  expect(header()).not.toBeNull();
  expect(grabber()).toBeNull();

  setHost({ ...initial, destination: { area: "details", page: { ...page, resizable: true } } });
  flush();
  expect(grabber()).not.toBeNull();

  chrome.resolve();
  await waitForSolid(() => expect(header()?.querySelector("button")).not.toBeNull());
  expect(shell.querySelectorAll(".chat-mobile-host__header")).toHaveLength(1);
  expect(shell.querySelectorAll(".chat-mobile-host__grabber")).toHaveLength(1);
  expect(header()?.hasAttribute("aria-hidden")).toBe(false);
  expect(grabber()?.tagName).toBe("BUTTON");
});
