import { copyToClipboard } from "../../../lib/clipboard.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

export type FileCopyAction = "path" | "contents";
export type FileCopyFeedback = Partial<Record<FileCopyAction, "copied" | "failed">>;

export class FileCopyController {
  feedback: FileCopyFeedback = {};
  private readonly attempts = new Map<FileCopyAction, number>();
  private readonly timers = new Map<FileCopyAction, ReturnType<typeof globalThis.setTimeout>>();

  constructor(
    private readonly host: { readonly isConnected: boolean; requestUpdate(): void },
    private readonly content: () => SidebarContent | null,
  ) {}

  reset(): void {
    for (const timer of this.timers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.timers.clear();
    // Tokens stay monotonic so a pre-disconnect copy cannot own new feedback.
    for (const [action, attempt] of this.attempts) {
      this.attempts.set(action, attempt + 1);
    }
    this.feedback = {};
    if (this.host.isConnected) {
      this.host.requestUpdate();
    }
  }

  dispose(): void {
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
