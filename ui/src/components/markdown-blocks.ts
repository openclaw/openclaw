// One lifecycle owner for interactive Markdown in transcripts and previews.
import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { t } from "../i18n/index.ts";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationBinding,
  type PresentationValue,
} from "../lit/presentation-binding.ts";
import { updateCodeBlockWidthOverflow } from "./markdown-code-blocks.ts";
import { enhanceMarkdownTables, releaseMarkdownTables } from "./markdown-tables.ts";

let codeBlockRegionSequence = 0;
const blockSelector = ".code-block-wrapper, .markdown-mermaid";
class MarkdownBlocksDirective extends AsyncDirective {
  private root: HTMLElement | undefined;
  private observedRoot: HTMLElement | undefined;
  private scanPending = false;
  private active = true;
  private presentation?: PresentationBinding;
  private readonly handlePresentationChange = () => {
    if (this.presentation?.isPresented() === false) {
      this.active = false;
      this.release();
    }
  };
  private readonly pendingBlocks = new Set<HTMLElement>();
  private readonly observedNodes = new Set<HTMLElement>();
  private readonly resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          if (!this.active || !this.isConnected) {
            return;
          }
          const wrappers = new Set(
            entries.map(({ target }) => target.closest<HTMLElement>(".code-block-wrapper")),
          );
          for (const wrapper of wrappers) {
            if (wrapper) {
              updateCodeBlockWidthOverflow(wrapper);
            }
          }
        });
  private readonly mutationObserver = new MutationObserver((records) => {
    this.collectMutations(records);
    if (this.pendingBlocks.size) {
      this.scheduleScan();
    }
  });

  private collectMutations(records: MutationRecord[]): void {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const block = target?.closest<HTMLElement>(blockSelector);
      if (block) {
        this.pendingBlocks.add(block);
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) {
          this.collectBlocks(node);
        }
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || this.root?.contains(node)) {
          continue;
        }
        const removed = [node, ...node.querySelectorAll<HTMLElement>(".code-block-viewport, code")];
        for (const observed of removed) {
          if (this.observedNodes.delete(observed)) {
            this.resizeObserver?.unobserve(observed);
          }
        }
      }
    }
  }

  render(_presented: PresentationValue = true) {
    return nothing;
  }

  override update(part: ElementPart, [presented = true]: [PresentationValue?]) {
    const previousOwner = this.presentation?.owner;
    const presentation = typeof presented === "boolean" ? undefined : presented;
    this.presentation = presentation;
    if (previousOwner !== presentation?.owner) {
      previousOwner?.removeEventListener(PRESENTATION_CHANGED_EVENT, this.handlePresentationChange);
      if (this.isConnected) {
        presentation?.owner.addEventListener(
          PRESENTATION_CHANGED_EVENT,
          this.handlePresentationChange,
        );
      }
    }
    const root = part.element instanceof HTMLElement ? part.element : undefined;
    if (root !== this.root) {
      this.release();
      this.root = root;
    }
    this.active = typeof presented === "boolean" ? presented : presented.isPresented();
    if (this.active) {
      this.scheduleScan();
    } else {
      this.release();
    }
    return nothing;
  }

  protected override disconnected(): void {
    this.presentation?.owner.removeEventListener(
      PRESENTATION_CHANGED_EVENT,
      this.handlePresentationChange,
    );
    this.release();
  }

  private release(): void {
    // Hidden retained DOM keeps its controls, but must release foreground observers.
    this.mutationObserver.disconnect();
    this.observedRoot = undefined;
    this.pendingBlocks.clear();
    this.resizeObserver?.disconnect();
    this.observedNodes.clear();
    if (this.root) {
      releaseMarkdownTables(this.root);
    }
  }

  protected override reconnected(): void {
    this.presentation?.owner.addEventListener(
      PRESENTATION_CHANGED_EVENT,
      this.handlePresentationChange,
    );
    this.handlePresentationChange();
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanPending || !this.active || !this.isConnected) {
      return;
    }
    this.scanPending = true;
    // Element directives commit before their children. Coalesce after the commit,
    // and fence queued scans when the host is removed before the microtask runs.
    queueMicrotask(() => {
      this.scanPending = false;
      if (this.active && this.isConnected && this.root?.isConnected) {
        this.scan(this.root);
      }
    });
  }

  private scan(root: HTMLElement): void {
    // Session retirement can independently release the table owner. Reacquire it
    // after commit; an existing owner returns without walking retained history.
    enhanceMarkdownTables(root);
    if (this.observedRoot !== root) {
      this.collectBlocks(root);
      this.mutationObserver.observe(root, {
        childList: true,
        subtree: true,
        characterData: !this.resizeObserver,
      });
      this.observedRoot = root;
    }
    // Lit's post-commit scan can precede observer delivery. Wire new controls
    // from this commit's records before consumers observe the rendered result.
    this.collectMutations(this.mutationObserver.takeRecords());
    const blocks = [...this.pendingBlocks];
    this.pendingBlocks.clear();
    for (const wrapper of blocks) {
      if (!root.contains(wrapper)) {
        continue;
      }
      if (wrapper.matches(".markdown-mermaid")) {
        if (wrapper.querySelector("pre code")) {
          const isCurrent = () =>
            this.active &&
            this.isConnected &&
            this.root === root &&
            root.isConnected &&
            root.contains(wrapper);
          void import("./markdown-mermaid.ts").then(
            ({ mountMermaidBlocks }) => {
              if (isCurrent()) {
                mountMermaidBlocks(wrapper);
              }
            },
            () => {
              if (!isCurrent() || !wrapper.matches(".markdown-mermaid")) {
                return;
              }
              wrapper.classList.remove("markdown-mermaid");
              wrapper.prepend(t("chat.mermaid.rendererError"));
            },
          );
        }
        continue;
      }
      const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport");
      const code = viewport?.querySelector<HTMLElement>("code");
      if (!viewport || !code) {
        continue;
      }
      // Short streaming fences gain an Expand control without replacing their
      // wrapper. Bind the control when it appears, not only on the first scan.
      const expandButton = wrapper.querySelector<HTMLButtonElement>(".code-block-expand");
      if (expandButton) {
        if (!viewport.id) {
          viewport.id = `code-block-${++codeBlockRegionSequence}`;
        }
        if (expandButton.getAttribute("aria-controls") !== viewport.id) {
          expandButton.setAttribute("aria-controls", viewport.id);
        }
      }
      // A reconnected host reuses initialized DOM but must reacquire observation.
      for (const node of [viewport, code]) {
        if (!this.observedNodes.has(node)) {
          this.observedNodes.add(node);
          this.resizeObserver?.observe(node);
        }
      }
      if (!this.resizeObserver) {
        updateCodeBlockWidthOverflow(wrapper);
      }
    }
  }

  private collectBlocks(root: HTMLElement): void {
    if (root.matches(blockSelector)) {
      this.pendingBlocks.add(root);
    }
    for (const block of root.querySelectorAll<HTMLElement>(blockSelector)) {
      this.pendingBlocks.add(block);
    }
  }
}

export const markdownBlocks = directive(MarkdownBlocksDirective);
