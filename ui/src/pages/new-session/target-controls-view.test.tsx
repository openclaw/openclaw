/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CatalogBar } from "./catalog-target-view.tsx";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
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

it.each([
  { name: "guest click", writable: true, advertised: true, enter: false },
  { name: "guest Enter", writable: true, advertised: true, enter: true },
  { name: "read-only Enter", writable: false, advertised: true, enter: true },
  { name: "unadvertised create", writable: true, advertised: false, enter: true },
])("gates pasted Git URL selection for $name", ({ writable, advertised, enter }) => {
  const cloneUrl = "https://github.com/openclaw/openclaw.git";
  const f = createDraftFixture({
    scopes: ["operator.sessions.read", ...(writable ? ["operator.sessions.write"] : [])],
    methods: ["projects.add", ...(advertised ? ["sessions.create"] : [])],
  });
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
  const available = writable && advertised;
  const clone = container.querySelector<HTMLButtonElement>('[data-value="project-clone-url"]');
  expect(clone !== null).toBe(available);
  if (enter) {
    const input = container.querySelector<HTMLInputElement>(
      ".new-session-page__project-search input",
    )!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  } else {
    expect(clone?.disabled).toBe(false);
    clone!.click();
  }
  expect(f.place.browser.remoteProject).toEqual(
    available ? { identity: cloneUrl, cloneUrl } : null,
  );
  expect(f.request).not.toHaveBeenCalledWith("projects.add", expect.anything());
});
