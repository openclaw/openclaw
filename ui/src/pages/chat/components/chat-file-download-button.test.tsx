/* @vitest-environment jsdom */
import { createSignal, flush, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import * as toast from "../../../lib/toast.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["unmount", "session", "connection"])(
  "does not save bytes after %s changes",
  async (change) => {
    const bytes = createDeferredCore<{ url: string; filename: string } | null>();
    const download = vi.fn((signal: AbortSignal) => {
      void signal;
      return bytes.promise;
    });
    const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const [scope, setScope] = createSignal({ sessionKey: "agent:main:one", connectionEpoch: 1 });
    const view = mountSolid(() => (
      <FileDownloadButton scopeKey={JSON.stringify(scope())} download={download} class="download" />
    ));
    const button = view.container.querySelector("button");
    if (!button) {
      throw new Error("Download button is missing");
    }
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(download).toHaveBeenCalledOnce();
    if (change === "unmount") {
      view.unmount();
    } else {
      setScope({
        sessionKey: change === "session" ? "agent:main:two" : "agent:main:one",
        connectionEpoch: change === "connection" ? 2 : 1,
      });
      flush();
    }
    bytes.resolve({ url: "/api/artifacts/download/connection/ticket", filename: "report.md" });
    if (change === "unmount") {
      expect(download.mock.calls[0]?.[0].aborted).toBe(true);
    } else {
      await waitForSolid(() => expect(button.disabled).toBe(false));
    }
    expect(save).not.toHaveBeenCalled();
  },
);

it.each(["during download", "after start"])("closes the reader %s", async (timing) => {
  const bytes = createDeferredCore<{ url: string; filename: string } | null>();
  const [visible, setVisible] = createSignal(true);
  const download = vi.fn((signal: AbortSignal) => {
    void signal;
    if (timing === "during download") {
      setVisible(false);
    }
    return bytes.promise;
  });
  const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const view = mountSolid(() => (
    <Show when={visible()}>
      <FileDownloadButton scopeKey="reader" download={download} class="download" />
    </Show>
  ));
  view.getByRole("button").click();
  if (timing === "after start") {
    await waitForSolid(() => expect(view.getByRole("button").hasAttribute("disabled")).toBe(true));
    setVisible(false);
  }
  await waitForSolid(() => expect(view.queryByRole("button")).toBeNull());
  expect(download.mock.calls[0]?.[0].aborted).toBe(true);
  bytes.resolve({ url: "/api/artifacts/download/connection/ticket", filename: "report.md" });
  await bytes.promise;
  expect(save).not.toHaveBeenCalled();
});

it("shows download progress, rejects duplicate clicks, and lets a failed download retry", async () => {
  const bytes = createDeferredCore<{ url: string; filename: string } | null>();
  const download = vi
    .fn()
    .mockReturnValueOnce(bytes.promise)
    .mockResolvedValue({ url: "/api/artifacts/download/connection/ticket", filename: "report.md" });
  const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const report = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const view = mountSolid(() => (
    <FileDownloadButton scopeKey="reader" download={download} class="download" showLabel />
  ));
  const button = view.getByRole("button");
  button.click();
  button.click();
  await waitForSolid(() => expect(button.hasAttribute("disabled")).toBe(true));
  expect(button.getAttribute("aria-label")).toBe("Downloading…");
  expect(button.textContent).toContain("Downloading…");
  expect(download).toHaveBeenCalledOnce();
  bytes.reject(new Error("Download unavailable"));
  await waitForSolid(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(report).toHaveBeenCalledWith({ message: expect.stringContaining("Download unavailable") });
  expect(save).not.toHaveBeenCalled();
  button.click();
  await waitForSolid(() => expect(save).toHaveBeenCalledOnce());
});
