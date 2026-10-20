/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import {
  forgetInstantThreadPage,
  retainInstantThreadRestore,
  takeInstantThreadRestore,
} from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import { renderSolid } from "./new-session-page-entry.ts";
import type { PageHost } from "./new-session-page-owner.ts";

function routeData(agentId = "main"): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId: "",
    catalogLabel: "",
    startTerminal: false,
  };
}

function mountRoute(props: { data: NewSessionRouteData | undefined }) {
  const view = mountSolid(() =>
    createComponent(renderSolid, {
      get data() {
        return props.data;
      },
      loaderPending: false,
      presented: true,
    }),
  );
  onTestFinished(view.unmount);
  return view.container;
}

function retainedDraft() {
  const { context, flow, gateway } = createDraftFixture();
  const auth = context.gateway.snapshot.hello?.auth;
  if (!auth) {
    throw new Error("Retained draft fixture requires authenticated hello");
  }
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
  const restored = takeInstantThreadRestore(context, "?agent=main");
  if (!restored) {
    throw new Error("Retained draft fixture requires an owned restore");
  }
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

describe("new-session native route entry", () => {
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
    await waitForSolid(() =>
      expect(page.querySelector(".new-session-page__message")).not.toBeNull(),
    );
  });

  it("updates loader data without replacing the registered page host", async () => {
    const initial = routeData("research");
    const resolved = routeData("main");
    const [data, setData] = createSignal<NewSessionRouteData | undefined>(initial);
    const container = mountRoute({
      get data() {
        return data();
      },
    });
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

  it("reuses the authorized retained DOM and its unsent input", async () => {
    const { data, page, input } = retainedDraft();
    const container = mountRoute({ data });
    await waitForSolid(() => expect(container.firstElementChild).toBe(page));
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("Keep this private unsent draft");
    expect(container.querySelector("openclaw-new-session-page")).toBeNull();
  });

  it("replaces the displayed restored page when a later rollback supplies another host", async () => {
    const first = retainedDraft();
    const second = retainedDraft();
    const [data, setData] = createSignal<NewSessionRouteData>(first.data);
    const container = mountRoute({
      get data() {
        return data();
      },
    });
    await waitForSolid(() => expect(container.firstElementChild).toBe(first.page));
    setData(second.data);
    await waitForSolid(() => expect(container.firstElementChild).toBe(second.page));
    expect(container.contains(first.input)).toBe(false);
    expect(container.contains(second.input)).toBe(true);
  });

  it("renders a fresh page when retained draft authority changes before rendering", async () => {
    const { auth, data, page, input } = retainedDraft();
    auth.recoveryScope = "replacement-principal";
    const container = mountRoute({ data });
    await waitForSolid(() =>
      expect(container.querySelector<PageHost>("openclaw-new-session-page")?.data).toBe(data),
    );
    expect(container.contains(page)).toBe(false);
    expect(container.contains(input)).toBe(false);
  });
});
