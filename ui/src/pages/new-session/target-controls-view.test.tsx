/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { CatalogBar } from "./catalog-target-view.tsx";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { createNewSessionRouteData } from "./location.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionPlaceControls } from "./target-controls-view.tsx";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

it("dispatches catalog retry through the current callback without replacing the button", () => {
  const original = vi.fn();
  const replacement = vi.fn();
  const [retry, setRetry] = createSignal(() => original);
  const { container } = mountSolid(() => (
    <CatalogBar
      retrying={false}
      groupPending
      onRetry={retry()}
      agentSelect={undefined}
      placeSelect={undefined}
    />
  ));
  const button = container.querySelector("button")!;
  button.click();
  expect(original).toHaveBeenCalledOnce();

  setRetry(() => replacement);
  flush();
  expect(container.querySelector("button")).toBe(button);
  button.click();
  expect(original).toHaveBeenCalledOnce();
  expect(replacement).toHaveBeenCalledOnce();
});

it("retains catalog retry readiness through coalesced requests and host completion", async () => {
  const first = createDeferred();
  const second = createDeferred();
  const rendered = createDeferred();
  const data: NewSessionRouteData = { ...createNewSessionRouteData(), catalogId: "terminal" };
  const [revision, setRevision] = createSignal(0);
  const updateComplete = vi.fn(() => rendered.promise);
  const f = createDraftFixture({
    data,
    onChange: () => setRevision((value) => value + 1),
    updateComplete,
  });
  onTestFinished(() => f.gateway.disconnect());
  const revalidate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  Object.assign(f.context, { revalidate });
  const gateway = () => {
    revision();
    return f.gateway;
  };
  const { container } = mountSolid(() => (
    <CatalogBar
      data={data}
      groupPending
      retrying={gateway().catalogRetrying}
      retryRead={gateway().catalogRetryRead}
      onRetry={() => f.gateway.handleCatalogRetry()}
      agentSelect={undefined}
      placeSelect={undefined}
    />
  ));
  const button = container.querySelector("button")!;
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  expect(button.textContent).toContain("Loading");
  f.gateway.handleCatalogRetry();
  expect(revalidate).toHaveBeenCalledTimes(1);

  first.resolve();
  await waitForFast(() => expect(updateComplete).toHaveBeenCalledOnce());
  expect(button.disabled).toBe(true);
  expect(revalidate).toHaveBeenCalledTimes(1);
  rendered.resolve();
  await waitForFast(() => expect(revalidate).toHaveBeenCalledTimes(2));
  expect(container.querySelector("button")).toBe(button);
  expect(button.disabled).toBe(true);

  data.startTerminal = true;
  data.catalogLabel = "Terminal";
  second.resolve();
  await waitForFast(() => expect(button.disabled).toBe(false));
  expect(container.querySelector("button")).toBe(button);
  expect(button.textContent).toContain("Retry");
});

it("retries a rejected catalog read through the current owner", async () => {
  const failed = createDeferred();
  const recovered = createDeferred();
  const [read, setRead] = createSignal<{ promise?: Promise<void> }>({});
  const retry = vi.fn(() => setRead({ promise: recovered.promise }));
  const { container } = mountSolid(() => (
    <CatalogBar
      groupPending
      retrying={false}
      retryRead={read().promise}
      onRetry={retry}
      agentSelect={undefined}
      placeSelect={undefined}
    />
  ));
  setRead({ promise: failed.promise });
  await waitForSolid(() =>
    expect(container.querySelector("button")!.disabled, "initial read pending").toBe(true),
  );
  failed.reject(new Error("catalog unavailable"));
  await waitForFast(() => expect(container.querySelector("button")!.disabled).toBe(false));
  container.querySelector("button")!.click();
  await waitForSolid(() =>
    expect(container.querySelector("button")!.disabled, "retry read pending").toBe(true),
  );
  expect(retry).toHaveBeenCalledOnce();
  recovered.resolve();
  await waitForFast(() => expect(container.querySelector("button")!.disabled).toBe(false));
});

it.each([
  { name: "guest click", writable: true, advertised: true, enter: false },
  { name: "guest Enter", writable: true, advertised: true, enter: true },
  { name: "IME Enter", writable: true, advertised: true, enter: true, composing: "flag" },
  { name: "WebKit IME Enter", writable: true, advertised: true, enter: true, composing: "end" },
  { name: "read-only Enter", writable: false, advertised: true, enter: true },
  { name: "unadvertised create", writable: true, advertised: false, enter: true },
])(
  "gates pasted Git URL selection for $name",
  async ({ writable, advertised, enter, composing }) => {
    const cloneUrl = "https://github.com/openclaw/openclaw.git";
    const f = createDraftFixture({
      scopes: ["operator.sessions.read", ...(writable ? ["operator.sessions.write"] : [])],
      methods: ["projects.add", ...(advertised ? ["sessions.create"] : [])],
    });
    f.place.browser.popoverCallbacks("project").onPopoverShow();
    f.place.browser.changeProjectQuery(cloneUrl);
    const { container } = mountSolid(() => (
      <NewSessionPlaceControls
        params={{
          context: f.context,
          data: undefined,
          gateway: f.gateway,
          place: f.place,
          submitting: false,
          pendingPlacement: false,
          onConnectMachine: vi.fn(),
          onNavigate: vi.fn(),
          onFocusComposer: vi.fn(),
          onChange: vi.fn(),
        }}
      />
    ));
    await waitForSolid(() =>
      expect(container.querySelector(".new-session-page__project-search input")).not.toBeNull(),
    );
    const available = writable && advertised;
    const clone = container.querySelector<HTMLButtonElement>('[data-value="project-clone-url"]');
    expect(clone !== null).toBe(available);
    if (enter) {
      const input = container.querySelector<HTMLInputElement>(
        ".new-session-page__project-search input",
      )!;
      if (composing === "end") {
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      }
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: composing === "flag",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      expect(clone?.disabled).toBe(false);
      clone!.click();
    }
    expect(f.place.browser.remoteProject).toEqual(
      available && !composing ? { identity: cloneUrl, cloneUrl } : null,
    );
    expect(f.request).not.toHaveBeenCalledWith("projects.add", expect.anything());
  },
);
