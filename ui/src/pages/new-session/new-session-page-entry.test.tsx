/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished } from "vitest";
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

it("updates loader data without replacing the registered page host", async () => {
  const initial = routeData("research");
  const resolved = routeData("main");
  const { container, setData } = mountRoute(initial);
  await waitForSolid(() =>
    expect(container.querySelector<PageHost>("openclaw-new-session-page")?.data).toBe(initial),
  );
  const page = container.querySelector<PageHost>("openclaw-new-session-page");
  setData(undefined);
  await waitForSolid(() => {
    expect(container.querySelector("openclaw-new-session-page")).toBe(page);
    expect(page?.data).toBeUndefined();
  });
  setData(resolved);
  await waitForSolid(() => {
    expect(container.querySelector("openclaw-new-session-page")).toBe(page);
    expect(page?.data).toBe(resolved);
  });
});

it.each([true, false])("reuses retained DOM only while authorized (%s)", async (authorized) => {
  const { auth, data, page, input } = retainedDraft();
  if (!authorized) {
    auth.recoveryScope = "replacement-principal";
  }
  const { container } = mountRoute(data);
  if (authorized) {
    await waitForSolid(() => expect(container.firstElementChild).toBe(page));
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("Keep this private unsent draft");
    expect(container.querySelector("openclaw-new-session-page")).toBeNull();
  } else {
    await waitForSolid(() =>
      expect(container.querySelector<PageHost>("openclaw-new-session-page")?.data).toBe(data),
    );
    expect(container.contains(page)).toBe(false);
    expect(container.contains(input)).toBe(false);
  }
});

it("replaces the displayed restored page when a later rollback supplies another host", async () => {
  const first = retainedDraft();
  const second = retainedDraft();
  const { container, setData } = mountRoute(first.data);
  await waitForSolid(() => expect(container.firstElementChild).toBe(first.page));
  setData(second.data);
  await waitForSolid(() => expect(container.firstElementChild).toBe(second.page));
  expect(container.contains(first.input)).toBe(false);
  expect(container.contains(second.input)).toBe(true);
});
