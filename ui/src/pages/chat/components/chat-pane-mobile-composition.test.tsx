/* @vitest-environment jsdom */
import { dynamic } from "@solidjs/web";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { offlineDeviceSession } from "../chat-pane.test-support.ts";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

it("clears the device name while replacing its request and ignores retired results", async () => {
  const first = createDeferred<string | undefined>();
  const obsolete = createDeferred<string | undefined>();
  const current = createDeferred<string | undefined>();
  const readFirst = vi.fn(() => first.promise);
  const mounted = mountHeader({ session: offlineDeviceSession(), readMachineName: readFirst });
  const name = () => mounted.container.querySelector(".chat-pane__device-name")?.textContent;
  expect(name()).toBeUndefined();
  first.resolve("First device");
  await waitForSolid(() => expect(name()).toBe("First device"));
  const title = mounted.container.querySelector(".chat-pane__session-title");
  mounted.update({ title: "Updated session title" });
  expect(readFirst).toHaveBeenCalledOnce();
  expect(name()).toBe("First device");
  mounted.update({ readMachineName: () => obsolete.promise });
  expect(name()).toBeUndefined();
  mounted.update({ readMachineName: () => current.promise });
  obsolete.resolve("Retired device");
  await obsolete.promise;
  expect(name()).toBeUndefined();
  current.resolve("Current device");
  await waitForSolid(() => expect(name()).toBe("Current device"));
  expect(mounted.container.querySelector(".chat-pane__session-title")).toBe(title);
  mounted.update({ readMachineName: undefined });
  expect(name()).toBeUndefined();
});

it("retains the People page and lookup across native host replacement and desktop parking", async () => {
  const release = vi.fn();
  const mentions = {
    status: "idle" as const,
    error: undefined,
    truncated: false,
    read: () => null,
    activate: vi.fn(() => release),
    request: async () => {},
    insert: () => false,
  };
  const mobileHost: ChatMobileHost = {
    scopeKey: "people-retention",
    open: false,
    suspended: false,
    mode: "expanded",
    height: undefined,
    reservedHeight: 0,
    destination: { area: "panels" },
    detailsMount: null,
    setDetailsMount: vi.fn(),
    navigate: (destination) => {
      mobileHost.open = true;
      mobileHost.destination = destination;
      refreshHost();
    },
    reveal: vi.fn(),
    close: vi.fn(),
    back: vi.fn(),
    toggleExpanded: vi.fn(),
    resize: vi.fn(),
    keyboardVisible: false,
    onComposerEditingChange: vi.fn(),
  };
  const detailsControl = {
    chat: undefined,
    elements: {},
    mobile: true,
    mobileHost,
    presentation: true,
    setRef: vi.fn(),
  };
  const mounted = mountHeader({
    mergedChrome: true,
    detailsControl,
    mobilePeople: {
      header: [
        { key: "ada", sender: { name: "Ada" }, label: "Ada", firstName: "Ada", viewing: true },
      ],
      viewers: [],
      participants: [],
      unlistedParticipantCount: 0,
      participantsComplete: false,
    },
    mobilePeopleMentions: mentions,
  });
  function refreshHost() {
    mounted.update({ detailsControl: { ...detailsControl, mobileHost: { ...mobileHost } } });
  }
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".chat-mobile-people-grid")!;
  expect(mentions.activate).not.toHaveBeenCalled();
  trigger.click();
  const renderPage = mobileHost.destination.page!.render!;
  const mountPage = () =>
    mountSolid(() => {
      const Page = dynamic(() => renderPage);
      return <Page />;
    });
  const firstPage = mountPage();
  await waitForSolid(() =>
    expect(firstPage.queryByRole("group", { name: "People" })).not.toBeNull(),
  );
  const retainedPage = firstPage.container.querySelector("#pane-1-mobile-people");
  expect(retainedPage).not.toBeNull();
  expect(mentions.activate).toHaveBeenCalledOnce();
  mounted.update({
    title: "Updated title",
    mobilePeopleMentions: { ...mentions, status: "loading" },
  });
  mounted.update({
    mergedChrome: false,
    detailsControl: { ...detailsControl, mobileHost: undefined },
  });
  mounted.update({ mergedChrome: true, detailsControl });
  expect(mounted.container.querySelector(".chat-mobile-people-grid")).toBe(trigger);
  expect(mentions.activate).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  firstPage.unmount();
  mobileHost.open = false;
  refreshHost();
  expect(release).toHaveBeenCalledOnce();
  mounted.update({
    mergedChrome: false,
    detailsControl: { ...detailsControl, mobileHost: undefined },
    mobilePeopleMentions: { ...mentions, status: "error", error: "Retained lookup needs retry" },
  });
  mobileHost.open = true;
  mounted.update({ mergedChrome: true, detailsControl });
  const returnedPage = mountPage();
  expect(returnedPage.container.querySelector("#pane-1-mobile-people")).toBe(retainedPage);
  expect(returnedPage.getByRole("alert").textContent).toContain("Retained lookup needs retry");
  expect(mentions.activate).toHaveBeenCalledTimes(2);
  mounted.unmount();
  expect(release).toHaveBeenCalledTimes(2);
  expect(renderPage()).toBeUndefined();
  returnedPage.unmount();
});
