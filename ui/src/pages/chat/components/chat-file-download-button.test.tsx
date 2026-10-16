/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
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
    flush();
    expect(button.disabled).toBe(true);
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
