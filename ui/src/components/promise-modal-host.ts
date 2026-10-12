import { nothing, render } from "lit";
import "./modal-dialog.ts";

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
  return new Promise((resolve) => {
    let disposeContent: (() => void) | undefined;
    const modal = {
      host,
      settled: false,
      render(content: () => Content) {
        if (!modal.settled) {
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
        abort?.signal?.removeEventListener("abort", handleAbort);
        disposeContent?.();
        if (!mountContent) {
          render(nothing, host);
        }
        host.remove();
        resolve(value);
      },
    };
    const handleAbort = () => abort && modal.finish(abort.value);
    abort?.signal?.addEventListener("abort", handleAbort, { once: true });
    initialize(modal);
  });
}
