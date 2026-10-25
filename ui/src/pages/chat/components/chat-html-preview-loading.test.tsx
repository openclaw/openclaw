/* @vitest-environment jsdom */
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../../app/context.ts";
import {
  cancelStaleChunkRecovery,
  installStaleChunkReloadListener,
} from "../../../app/stale-chunk-reload.ts";
import * as storageAccess from "../../../local-storage.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { HtmlPreview } from "./chat-html-preview-view.tsx";
import { createFileHtmlPreview } from "./chat-html-preview.ts";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";

const { retryStale } = vi.hoisted(() => ({
  retryStale: vi.fn<(options: { canReload: () => boolean }) => Promise<boolean>>(),
}));
vi.mock("../../../app/stale-chunk-reload.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../app/stale-chunk-reload.ts")>();
  return {
    ...original,
    // Vitest wraps rejected module factories; browsers reject with the import error itself.
    isStaleChunkImportError: (error: unknown) =>
      original.isStaleChunkImportError(error instanceof Error ? (error.cause ?? error) : error),
    retryStaleChunkReloadWhenReachable: retryStale,
  };
});

let stopRecovery: (() => void) | undefined;

afterEach(() => {
  stopRecovery?.();
  cancelStaleChunkRecovery();
  vi.unstubAllGlobals();
  vi.doUnmock("./chat-html-preview-element.tsx");
  vi.restoreAllMocks();
});

it("defers HTML controls, retries imports, and retains the frame across source toggles", async () => {
  const initialLoad = createDeferred();
  const staleLoad = createDeferred();
  const retryLoad = createDeferred();
  const moduleLoaded = createDeferred();
  const load = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(initialLoad.promise)
    .mockReturnValueOnce(staleLoad.promise)
    .mockReturnValueOnce(retryLoad.promise);
  const probe = createDeferred<Response>();
  const fetchDocument = vi.fn(() => probe.promise);
  vi.stubGlobal("fetch", fetchDocument);
  window.sessionStorage.removeItem("openclaw.controlUi.staleChunkReloadBuildId");
  vi.spyOn(storageAccess, "getSafeSessionStorage").mockReturnValue(window.sessionStorage);
  const persist = vi.spyOn(Storage.prototype, "setItem");
  stopRecovery = installStaleChunkReloadListener();
  const recovery = createDeferred<boolean>();
  retryStale.mockReturnValueOnce(recovery.promise).mockResolvedValueOnce(false);
  vi.doMock(import("./chat-html-preview-element.tsx"), async (importOriginal) => {
    await load();
    const loaded = await importOriginal();
    moduleLoaded.resolve();
    return loaded;
  });
  const request = vi.fn().mockResolvedValue({
    html: "<h1>Preview</h1>",
    sandboxUrl: "/mcp-app-sandbox?frames=none",
    sandboxPort: 8444,
  });
  // SAFETY: The preview consumes only these Gateway members in this focused fixture.
  const context = {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
      subscribe: () => () => {},
    },
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const first: FileSidebarContent = {
    kind: "file",
    path: "first.html",
    name: "first.html",
    content: "<h1>First</h1>",
    line: 1,
  };
  let replaceFile!: (file: FileSidebarContent) => void;
  function Fixture() {
    const [file, setFile] = createSignal(first);
    replaceFile = setFile;
    const preview = createFileHtmlPreview(
      file,
      () => null,
      () => file().content,
    );
    const controls = () =>
      preview.controls({
        error: null,
        onRetry: () => {},
        onToggle: () => preview.toggle(),
        runtime: {},
        mode: "strict",
      });
    return (
      <Show when={controls()}>
        {(control) => (
          <>
            <button onClick={() => control().onToggle()}>Toggle source</button>
            <div class="chat-html-preview" hidden={control().source}>
              <Show when={control().presentation}>
                {(presentation) => <HtmlPreview {...presentation()} />}
              </Show>
            </div>
          </>
        )}
      </Show>
    );
  }
  const view = mountSolid(() => <Fixture />, {
    wrapper: provider.wrapper,
    container: document.body.appendChild(createApplicationContextProvider(context)),
  });
  flush();
  expect(load).not.toHaveBeenCalled();
  expect(view.container.querySelector("openclaw-chat-html-preview")).toBeNull();
  view.container.querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() => expect(load).toHaveBeenCalledOnce());
  expect(
    view.container.querySelector('[role="status"]'),
    "initial import is pending",
  ).not.toBeNull();
  initialLoad.reject(new Error("Synthetic preview import failed"));
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic preview import failed",
    ),
  );
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(load).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector('[role="status"]'), "retry import is pending").not.toBeNull();
  const staleFailure = new Error("Failed to fetch dynamically imported module");
  staleLoad.reject(staleFailure);
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.defineProperty(event, "payload", { value: staleFailure });
  window.dispatchEvent(event);
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to fetch dynamically imported module",
    ),
  );
  await waitForSolid(() => expect(fetchDocument).toHaveBeenCalledOnce());
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() =>
    expect(
      view.container.querySelector('[role="status"]'),
      "stale recovery is pending",
    ).not.toBeNull(),
  );
  const canReload = retryStale.mock.calls[0]![0].canReload;
  expect(canReload()).toBe(true);
  replaceFile({ ...first, line: undefined });
  flush();
  expect(canReload()).toBe(true);
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  replaceFile({
    ...first,
    path: "current.html",
    name: "current.html",
    content: "<h1>Current</h1>",
    line: undefined,
  });
  flush();
  expect(canReload()).toBe(false);
  probe.resolve(new Response(null, { status: 200 }));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(persist).not.toHaveBeenCalledWith(
    "openclaw.controlUi.staleChunkReloadBuildId",
    expect.any(String),
  );
  recovery.resolve(false);
  await waitForSolid(() =>
    expect(
      view.container.querySelector('[role="alert"]'),
      "retired recovery returns to retry",
    ).not.toBeNull(),
  );
  expect(load).toHaveBeenCalledTimes(2);
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(load).toHaveBeenCalledTimes(3));
  const removed = mountSolid(
    () => (
      <HtmlPreview
        content="<h1>Removed</h1>"
        sourceIdentity="removed.html"
        title="Removed"
        embedSandboxMode="strict"
      />
    ),
    { wrapper: provider.wrapper },
  );
  removed.unmount();
  retryLoad.resolve();
  await moduleLoaded.promise;
  await waitForSolid(() =>
    expect(
      view.container.querySelector("iframe"),
      "current preview loads its frame",
    ).not.toBeNull(),
  );
  expect(load).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "canvas.document.preview",
    { html: "<h1>Current</h1>" },
    expect.any(Object),
  );
  const frame = view.container.querySelector("iframe");
  view.container.querySelector<HTMLButtonElement>("button")!.click();
  flush();
  expect(view.container.querySelector<HTMLElement>(".chat-html-preview")?.hidden).toBe(true);
  expect(view.container.querySelector("iframe")).toBe(frame);
  view.container.querySelector<HTMLButtonElement>("button")!.click();
  flush();
  expect(view.container.querySelector<HTMLElement>(".chat-html-preview")?.hidden).toBe(false);
  expect(view.container.querySelector("iframe")).toBe(frame);
  expect(request).toHaveBeenCalledOnce();
});
