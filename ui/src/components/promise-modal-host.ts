import { render, type JSX } from "@solidjs/web";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";
import { listen } from "../lib/reactive/listener.ts";

/** Owns one imperative modal host; dismissal and reentrancy stay with its dialog. */
export function withPromiseModalHost<T>(
  abort: { signal?: AbortSignal; value: T } | undefined,
  initialize: (modal: {
    finish: (value: T) => void;
    render: (content: () => JSX.Element) => void;
    readonly settled: boolean;
  }) => void | Promise<void>,
): Promise<T> {
  if (abort?.signal?.aborted) {
    return Promise.resolve(abort.value);
  }
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve, reject) => {
    let disposeContent: (() => void) | undefined;
    let pendingContent: (() => JSX.Element) | undefined;
    let ready = customElements.get("openclaw-modal-dialog") !== undefined;
    const cleanup = () => {
      stopAbort?.();
      pendingContent = undefined;
      disposeContent?.();
      host.remove();
    };
    const modal = {
      settled: false,
      render(content: () => JSX.Element) {
        if (modal.settled) {
          return;
        }
        pendingContent = content;
        if (ready) {
          disposeContent?.();
          disposeContent = render(content, host);
        }
      },
      finish(value: T) {
        if (modal.settled) {
          return;
        }
        modal.settled = true;
        cleanup();
        resolve(value);
      },
    };
    const handleAbort = () => abort && modal.finish(abort.value);
    const stopAbort = abort?.signal && listen(abort.signal, "abort", handleAbort, { once: true });
    const fail = (error: unknown) => {
      if (!modal.settled) {
        modal.settled = true;
        cleanup();
        reject(
          error instanceof Error ? error : new Error("Unable to open dialog", { cause: error }),
        );
      }
    };
    // Initializers publish caller-owned reentrancy state before any asynchronous work.
    try {
      void Promise.resolve(initialize(modal)).catch(fail);
    } catch (error) {
      fail(error);
    }
    if (!ready && !modal.settled) {
      void ensureCustomElementDefined("openclaw-modal-dialog", () => import("./modal-dialog.tsx"))
        .then(() => {
          ready = true;
          if (!modal.settled && pendingContent) {
            modal.render(pendingContent);
          }
        })
        .catch(fail);
    }
  });
}
