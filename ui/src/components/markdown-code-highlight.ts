import DOMPurify from "dompurify";
import { listen } from "../lib/reactive/listener.ts";
import { observeIntersection } from "../lib/reactive/observers.ts";
import type { CodeHighlightReply, CodeHighlightRequest } from "./markdown-code-highlight-chunks.ts";

let worker: Worker | undefined;
let workerUsers = 0;
let sequence = 0;
const pending = new Map<number, (reply: CodeHighlightReply) => void>();
let sanitizer: ReturnType<typeof DOMPurify> | undefined;

function retainWorker() {
  workerUsers += 1;
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (--workerUsers === 0) {
      worker?.terminate();
      worker = undefined;
      pending.clear();
    }
  };
}

function requestHighlight(
  source: string,
  language: string,
  receive: (reply: CodeHighlightReply) => void,
) {
  const id = ++sequence;
  if (!worker) {
    worker = new Worker(new URL("./markdown-code-highlight.worker.ts", import.meta.url), {
      type: "module",
    });
    listen(worker, "message", ({ data }: MessageEvent<CodeHighlightReply>) => {
      const callback = pending.get(data.id);
      pending.delete(data.id);
      callback?.(data);
    });
    listen(worker, "error", () => {
      worker?.terminate();
      worker = undefined;
      const callbacks = [...pending];
      pending.clear();
      for (const [requestId, callback] of callbacks) {
        callback({ id: requestId, chunks: null, previewEnd: 0, highlighted: false });
      }
    });
  }
  pending.set(id, receive);
  worker.postMessage({ id, source, language } satisfies CodeHighlightRequest, { transfer: [] });
  return () => pending.delete(id);
}

type Block = {
  wrapper: HTMLElement;
  viewport: HTMLElement;
  code: HTMLElement;
  language: string;
  tail: Text;
  visible: boolean;
  applied: number;
  next: number;
  reply?: CodeHighlightReply;
  complete: boolean;
  frame?: number;
  cancel?: () => void;
  releaseWorker?: () => void;
  stopObserving?: () => void;
  stopSelection?: () => void;
};

/** Long fences keep their full plain text while visible syntax arrives in bounded pieces. */
export class MarkdownCodeHighlights {
  private readonly blocks = new Map<HTMLElement, Block>();
  private active = true;
  private stopClick: (() => void) | undefined;

  constructor(private readonly root: HTMLElement) {
    this.resume();
  }

  sync(wrapper: HTMLElement, viewport: HTMLElement, code: HTMLElement): void {
    const current = this.blocks.get(wrapper);
    // The reconciler replaces this opaque code node whenever its source changes.
    if (current?.code === code) {
      this.schedule(current);
      return;
    }
    if (current) {
      this.retire(current);
    }
    const tail =
      code.firstChild instanceof Text && code.childNodes.length === 1
        ? code.firstChild
        : document.createTextNode(code.textContent ?? "");
    if (tail.parentNode !== code) {
      code.replaceChildren(tail);
    }
    const block: Block = {
      wrapper,
      viewport,
      code,
      language: code.getAttribute("data-code-highlight") ?? "",
      tail,
      visible: false,
      applied: 0,
      next: 0,
      complete: false,
    };
    this.blocks.set(wrapper, block);
    this.observe(block);
  }

  prune(): void {
    for (const block of this.blocks.values()) {
      if (!this.root.contains(block.code)) {
        this.retire(block);
        this.blocks.delete(block.wrapper);
      }
    }
  }

  resume(): void {
    this.active = true;
    this.stopClick ??= listen(this.root, "click", (event) => {
      const target = event.target;
      const wrapper =
        target instanceof Element && target.closest<HTMLElement>(".code-block-wrapper");
      const block = wrapper && this.blocks.get(wrapper);
      if (block) {
        this.schedule(block);
      }
    });
    for (const block of this.blocks.values()) {
      this.observe(block);
    }
  }

  pause(): void {
    this.active = false;
    this.stopClick?.();
    this.stopClick = undefined;
    for (const block of this.blocks.values()) {
      this.retire(block);
    }
  }

  dispose(): void {
    this.pause();
    this.blocks.clear();
  }

  private retire(block: Block): void {
    block.stopObserving?.();
    block.stopObserving = undefined;
    block.visible = false;
    this.cancel(block);
  }

  private cancel(block: Block): void {
    if (block.frame !== undefined) {
      cancelAnimationFrame(block.frame);
      block.frame = undefined;
    }
    block.cancel?.();
    block.cancel = undefined;
    block.releaseWorker?.();
    block.releaseWorker = undefined;
    block.stopSelection?.();
    block.stopSelection = undefined;
  }

  private observe(block: Block): void {
    if (!this.active || block.stopObserving || block.complete) {
      return;
    }
    block.stopObserving = observeIntersection(
      [block.viewport],
      (entries) => {
        block.visible = entries.at(-1)?.isIntersecting === true;
        if (!block.visible) {
          this.cancel(block);
        } else if (block.reply) {
          this.schedule(block);
        } else if (!block.cancel) {
          block.releaseWorker ??= retainWorker();
          try {
            block.cancel = requestHighlight(
              block.code.textContent ?? "",
              block.language,
              (reply) => {
                block.cancel = undefined;
                block.releaseWorker?.();
                block.releaseWorker = undefined;
                if (!this.current(block)) {
                  return;
                }
                if (!reply.highlighted || !reply.chunks?.length) {
                  this.finish(block);
                  return;
                }
                block.reply = reply;
                while ((reply.chunks[block.next]?.to ?? Infinity) <= block.applied) {
                  block.next += 1;
                }
                if (reply.highlighted) {
                  block.code.classList.add("hljs");
                }
                this.schedule(block);
              },
            );
          } catch {
            this.finish(block);
          }
        }
      },
      { rootMargin: "240px 0px" },
    );
  }

  private current(block: Block): boolean {
    return (
      this.active &&
      block.visible &&
      this.blocks.get(block.wrapper) === block &&
      this.root.contains(block.code)
    );
  }

  private finish(block: Block): void {
    block.complete = true;
    block.stopObserving?.();
    block.stopObserving = undefined;
    this.cancel(block);
  }

  private schedule(block: Block): void {
    const reply = block.reply;
    if (
      !this.current(block) ||
      block.frame !== undefined ||
      !reply ||
      !reply.chunks?.[block.next]
    ) {
      return;
    }
    block.frame = requestAnimationFrame(() => {
      block.frame = undefined;
      if (!this.current(block)) {
        return;
      }
      const selection = this.root.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed) {
        for (let index = 0; index < selection.rangeCount; index += 1) {
          if (selection.getRangeAt(index).intersectsNode(block.code)) {
            // Moving selected text into syntax spans would collapse its live Range.
            block.stopSelection ??= listen(this.root.ownerDocument, "selectionchange", () => {
              block.stopSelection?.();
              block.stopSelection = undefined;
              this.schedule(block);
            });
            return;
          }
        }
      }
      // Group writes so the full block is not laid out after every small fragment.
      const deadline = performance.now() + 8;
      do {
        const chunk = reply.chunks![block.next]!;
        // Solid's delegated disclosure handler runs after the root click listener.
        if (!block.wrapper.classList.contains("is-expanded") && chunk.to > reply.previewEnd) {
          return;
        }
        const fragment = (sanitizer ??= DOMPurify(window)).sanitize(
          chunk.html.replaceAll("\r", "&#13;"),
          {
            ALLOWED_TAGS: ["span"],
            ALLOWED_ATTR: ["class"],
            RETURN_DOM_FRAGMENT: true,
          },
        );
        block.tail.before(fragment);
        block.tail.deleteData(0, chunk.to - block.applied);
        chunk.html = "";
        block.applied = chunk.to;
        block.next += 1;
        if (block.next === reply.chunks!.length) {
          block.reply = undefined;
          block.tail.remove();
          this.finish(block);
          return;
        }
      } while (performance.now() < deadline);
      this.schedule(block);
    });
  }
}
