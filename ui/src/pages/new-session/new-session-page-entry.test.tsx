/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import {
  forgetInstantThreadPage,
  retainInstantThreadRestore,
  takeInstantThreadRestore,
} from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import { renderSolid as Route } from "./new-session-page-entry.ts";
import type { PageHost } from "./new-session-page-owner.ts";

const routeData = (agentId = "main"): NewSessionRouteData => ({
  agentId,
  requestedAgentId: agentId,
  catalogId: "",
  catalogLabel: "",
  startTerminal: false,
});
const pageHost = (container: Element) =>
  container.querySelector<PageHost>("openclaw-new-session-page");

function mountRoute(initial: NewSessionRouteData) {
  const [data, setData] = createSignal<NewSessionRouteData | undefined>(initial);
  const view = mountSolid(() => <Route data={data()} loaderPending={false} presented={true} />);
  onTestFinished(view.unmount);
  return { container: view.container, setData };
}

function retainedDraft() {
  const { context, flow, gateway } = createDraftFixture();
  const auth = expectDefined(context.gateway.snapshot.hello?.auth, "authenticated hello");
  const client = context.gateway.snapshot.client;
  const recoveryScope = auth.recoveryScope;
  const data = routeData();
  const page = document.createElement("section");
  const input = page.appendChild(document.createElement("input"));
  input.value = "Keep this private unsent draft";
  const owns = () => context.gateway.snapshot.client === client;
  const clearRestore = retainInstantThreadRestore(context, {
    draft: { page, data, synchronizeGateway() {}, release() {} },
    owns,
    canDisplay: () =>
      owns() && context.gateway.snapshot.hello?.auth?.recoveryScope === recoveryScope,
    search: "?agent=main",
  });
  const restored = expectDefined(takeInstantThreadRestore(context, "?agent=main"), "owned restore");
  onTestFinished(() => {
    clearRestore();
    forgetInstantThreadPage(data, page);
    flow.disconnect();
    gateway.disconnect();
  });
  return { auth, data: restored, page, input };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

it("does not subscribe a discarded native draft to document visibility", () => {
  const subscribe = vi.spyOn(document, "addEventListener");
  onTestFinished(() => subscribe.mockRestore());
  const Page = expectDefined(customElements.get("openclaw-new-session-page"), "registered page");
  const renderPage: unknown = Reflect.get(Page, "render");
  if (typeof renderPage !== "function") {
    throw new Error("Expected the native bridge renderer");
  }
  mountSolid(() => {
    createRoot((dispose) => {
      // Exercise the registered renderer without committing its branch.
      Reflect.apply(renderPage, Page, [{ data: routeData("research") }]);
      dispose();
    });
    return null;
  });
  expect(subscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
});

it("offers an in-page retry after a native draft render fails", async () => {
  // SAFETY: The registered native bridge exposes PageHost properties and updateComplete.
  const page = document.createElement("openclaw-new-session-page") as PageHost;
  const data = routeData();
  let fail = true;
  Object.defineProperty(page, "data", {
    get: () => {
      if (fail) {
        throw new Error("Synthetic draft render failure");
      }
      return data;
    },
  });
  document.body.append(page);
  onTestFinished(() => page.remove());
  await page.updateComplete.catch(() => false);
  await waitForSolid(() =>
    expect(page.querySelector(".lazy-view-error")?.textContent).toContain(
      "Synthetic draft render failure",
    ),
  );
  fail = false;
  page.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(page.querySelector(".new-session-page__message")).not.toBeNull());
});

it("initializes the composer and retains it while loader data updates", async () => {
  const initial = routeData("research");
  const resolved = routeData("main");
  const { container, setData } = mountRoute(initial);
  await waitForSolid(() => expect(pageHost(container)?.data).toBe(initial));
  const page = pageHost(container);
  await waitForSolid(() => expect(page?.querySelector("textarea")).not.toBeNull());
  const input = page?.querySelector("textarea");
  await waitForSolid(() => expect(document.activeElement).toBe(input));
  setData(undefined);
  await waitForSolid(() => {
    expect(pageHost(container)).toBe(page);
    expect(page?.data).toBeUndefined();
    expect(page?.querySelector("textarea")).toBe(input);
  });
  setData(resolved);
  await waitForSolid(() => {
    expect(pageHost(container)).toBe(page);
    expect(page?.data).toBe(resolved);
    expect(page?.querySelector("textarea")).toBe(input);
  });
});

it("rejects retained DOM after its authorization changes", async () => {
  const { auth, data, page, input } = retainedDraft();
  auth.recoveryScope = "replacement-principal";
  const { container } = mountRoute(data);
  await waitForSolid(() => expect(pageHost(container)?.data).toBe(data));
  expect(container.contains(page)).toBe(false);
  expect(container.contains(input)).toBe(false);
});

it("restores owned DOM and replaces it when a later rollback supplies another host", async () => {
  const first = retainedDraft();
  const second = retainedDraft();
  const { container, setData } = mountRoute(first.data);
  await waitForSolid(() => expect(container.firstElementChild).toBe(first.page));
  expect(container.querySelector("input")).toBe(first.input);
  expect(first.input.value).toBe("Keep this private unsent draft");
  expect(pageHost(container)).toBeNull();
  setData(second.data);
  await waitForSolid(() => expect(container.firstElementChild).toBe(second.page));
  expect(container.contains(first.input)).toBe(false);
  expect(container.contains(second.input)).toBe(true);
});
