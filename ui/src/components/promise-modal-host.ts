import { nothing, render } from "lit";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";

type PromiseModalHost<T, Content> = {
  host: HTMLDivElement;
  finish: (value: T) => void;
  render: (content: () => Content) => void;
  readonly settled: boolean;
};

/** Owns one imperative modal host; dismissal and reentrancy stay with its dialog. */
export function withPromiseModalHost<T, Content = unknown>(
  abort: { signal?: AbortSignal; value: T } | undefined,
  initialize: (modal: PromiseModalHost<T, Content>) => void,
  mountContent?: (content: () => Content, host: HTMLDivElement) => () => void,
): Promise<T> {
  if (abort?.signal?.aborted) {
    return Promise.resolve(abort.value);
  }
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve, reject) => {
    let disposeContent: (() => void) | undefined;
    let pendingContent: (() => Content) | undefined;
    let ready = customElements.get("openclaw-modal-dialog") !== undefined;
    const cleanup = () => {
      abort?.signal?.removeEventListener("abort", handleAbort);
      pendingContent = undefined;
      disposeContent?.();
      if (!mountContent) {
        render(nothing, host);
      }
      host.remove();
    };
    const modal = {
      host,
      settled: false,
      render(content: () => Content) {
        if (modal.settled) {
          return;
        }
        pendingContent = content;
        if (ready) {
          if (mountContent) {
            disposeContent?.();
            disposeContent = mountContent(content, host);
          } else {
            render(content(), host);
          }
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
    abort?.signal?.addEventListener("abort", handleAbort, { once: true });
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
      initialize(modal);
    } catch (error) {
      fail(error);
    }
    if (!ready && !modal.settled) {
      void ensureCustomElementDefined("openclaw-modal-dialog", () => import("./modal-dialog.ts"))
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
