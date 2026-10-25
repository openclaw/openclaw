/* @vitest-environment jsdom */
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../../app/context.ts";
import * as staleRecovery from "../../../app/stale-chunk-reload.ts";
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

afterEach(() => {
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
  const query = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const retry = () => query(".lazy-view-error__action")!.click();
  const toggle = () => query("button")!.click();
  const pending = () => expect(query('[role="status"]')).not.toBeNull();
  const failed = (text: string) =>
    waitForSolid(() => expect(query('[role="alert"]')?.textContent).toContain(text));
  const loaded = (count: number) => waitForSolid(() => expect(load).toHaveBeenCalledTimes(count));
  flush();
  expect(load).not.toHaveBeenCalled();
  expect(query("openclaw-chat-html-preview")).toBeNull();
  toggle();
  await loaded(1);
  pending();
  initialLoad.reject(new Error("Synthetic preview import failed"));
  await failed("Synthetic preview import failed");
  retry();
  await loaded(2);
  pending();
  staleLoad.reject(new Error("Failed to fetch dynamically imported module"));
  await failed("Failed to fetch dynamically imported module");
  retry();
  await waitForSolid(pending);
  const canReload = retryStale.mock.calls[0]![0].canReload;
  const cancelRecovery = vi.spyOn(staleRecovery, "cancelStaleChunkRecovery");
  expect(canReload()).toBe(true);
  replaceFile({ ...first, line: undefined });
  flush();
  expect(canReload()).toBe(true);
  pending();
  replaceFile({
    ...first,
    path: "current.html",
    name: "current.html",
    content: "<h1>Current</h1>",
    line: undefined,
  });
  flush();
  expect(canReload()).toBe(false);
  expect(cancelRecovery).toHaveBeenCalledOnce();
  recovery.resolve(false);
  await waitForSolid(() => expect(query('[role="alert"]')).not.toBeNull());
  expect(load).toHaveBeenCalledTimes(2);
  retry();
  await loaded(3);
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
  await waitForSolid(() => expect(query("iframe")).not.toBeNull());
  expect(load).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "canvas.document.preview",
    { html: "<h1>Current</h1>" },
    expect.any(Object),
  );
  const frame = query("iframe");
  toggle();
  flush();
  expect(query(".chat-html-preview")?.hidden).toBe(true);
  expect(query("iframe")).toBe(frame);
  toggle();
  flush();
  expect(query(".chat-html-preview")?.hidden).toBe(false);
  expect(query("iframe")).toBe(frame);
  expect(request).toHaveBeenCalledOnce();
});
