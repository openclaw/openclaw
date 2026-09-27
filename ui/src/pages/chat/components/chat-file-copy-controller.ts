import type { ReactiveController, ReactiveControllerHost } from "lit";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import {
  emptyCopyFeedback,
  type FileCopyAction,
  type FileViewControls,
} from "./chat-sidebar-file-view.ts";

export class FileCopyController implements ReactiveController {
  feedback: FileViewControls["copyFeedback"] = emptyCopyFeedback;
  private readonly attempts = new Map<FileCopyAction, number>();
  private readonly timers = new Map<FileCopyAction, ReturnType<typeof globalThis.setTimeout>>();

  constructor(
    private readonly host: ReactiveControllerHost & { readonly isConnected: boolean },
    private readonly content: () => SidebarContent | null,
  ) {
    host.addController(this);
  }

  reset(): void {
    for (const timer of this.timers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.timers.clear();
    // Tokens stay monotonic so a pre-disconnect copy cannot own new feedback.
    for (const [action, attempt] of this.attempts) {
      this.attempts.set(action, attempt + 1);
    }
    this.feedback = emptyCopyFeedback;
    if (this.host.isConnected) {
      this.host.requestUpdate();
    }
  }

  hostConnected(): void {
    this.reset();
  }

  hostDisconnected(): void {
    this.reset();
  }

  readonly copy = (action: FileCopyAction): void => {
    const content = this.content();
    if (content?.kind !== "file") {
      return;
    }
    const attempt = (this.attempts.get(action) ?? 0) + 1;
    this.attempts.set(action, attempt);
    const isCurrent = () =>
      this.attempts.get(action) === attempt && this.content() === content && this.host.isConnected;
    void copyToClipboard(action === "path" ? content.path : content.content, isCurrent).then(
      (copied) => {
        if (!isCurrent()) {
          return;
        }
        this.feedback = { ...this.feedback, [action]: copied ? "copied" : "failed" };
        this.host.requestUpdate();
        globalThis.clearTimeout(this.timers.get(action));
        this.timers.set(
          action,
          globalThis.setTimeout(
            () => {
              this.timers.delete(action);
              this.feedback = { ...this.feedback, [action]: undefined };
              this.host.requestUpdate();
            },
            copied ? 1500 : 2000,
          ),
        );
      },
    );
  };
}
