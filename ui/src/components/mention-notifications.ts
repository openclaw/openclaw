import { consume } from "@lit/context";
import { nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { createMentionsCapability } from "../app/mentions.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  CHAT_SPLIT_NARROW_MEDIA_QUERY,
  type ChatSplitLayout,
} from "../pages/chat/split-layout-types.ts";
import { visiblePanesOf } from "../pages/chat/split-layout.ts";

type PendingMention = { mention: MentionInboxItem; abort: AbortController };
type NotificationView = typeof import("./mention-notification-view.ts");

class MentionNotifications extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) sessionKey: string | null = null;
  @property({ attribute: false }) splitLayout?: ChatSplitLayout;
  private narrow = false;

  private readonly pending = new Map<string, PendingMention>();
  private reconcile = () => {};
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this,
      () => {
        const media = globalThis.matchMedia(CHAT_SPLIT_NARROW_MEDIA_QUERY);
        const synchronize = () => {
          this.narrow = media.matches;
          this.reconcile();
        };
        synchronize();
        media.addEventListener("change", synchronize);
        return () => media.removeEventListener("change", synchronize);
      },
    )
    .effect(
      () => this.context,
      (context) => {
        const mentions = context.sidebarAttention.getMentions(createMentionsCapability);
        let viewLoad: Promise<NotificationView> | null = null;
        const forget = (entry: PendingMention) => {
          if (this.pending.get(entry.mention.id) === entry) {
            this.pending.delete(entry.mention.id);
          }
        };
        const cancel = (entry: PendingMention) => {
          forget(entry);
          entry.abort.abort();
        };
        this.reconcile = () => {
          const visible = new Set(mentions.snapshot.items.map((item) => item.id));
          for (const [id, entry] of this.pending) {
            if (!visible.has(id) || this.isVisible(entry.mention)) {
              cancel(entry);
            }
          }
        };
        const present = async (entry: PendingMention) => {
          try {
            // All arrivals await the same load in arrival order, preserving toast FIFO.
            viewLoad ??= import("./mention-notification-view.ts").catch((error: unknown) => {
              viewLoad = null;
              console.warn("[openclaw] Failed to load mention notifications", error);
              throw error;
            });
            const view = await viewLoad;
            if (
              this.context !== context ||
              entry.abort.signal.aborted ||
              this.isVisible(entry.mention)
            ) {
              cancel(entry);
              return;
            }
            view.showMentionNotification(entry.mention, context, entry.abort.signal, () =>
              forget(entry),
            );
          } catch {
            // The Inbox keeps the item; a failed lazy load must not retain transient work.
            cancel(entry);
          }
        };
        const stopState = mentions.subscribe(this.reconcile);
        const stopArrivals = mentions.subscribeArrivals((arrivals) => {
          for (const mention of arrivals) {
            if (this.isVisible(mention) || this.pending.has(mention.id)) {
              continue;
            }
            const entry = { mention, abort: new AbortController() };
            this.pending.set(mention.id, entry);
            void present(entry);
          }
        });
        return () => {
          stopArrivals();
          stopState();
          for (const entry of this.pending.values()) {
            cancel(entry);
          }
          this.reconcile = () => {};
        };
      },
    );

  private isVisible(mention: MentionInboxItem) {
    if (this.sessionKey === null) {
      return false;
    }
    return this.splitLayout
      ? visiblePanesOf(this.splitLayout, this.narrow).some((pane) =>
          areUiSessionKeysEquivalent(pane.sessionKey, mention.sessionKey),
        )
      : areUiSessionKeysEquivalent(this.sessionKey, mention.sessionKey);
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("sessionKey") || changed.has("splitLayout")) {
      this.reconcile();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    return nothing;
  }
}

customElements.define("openclaw-mention-notifications", MentionNotifications);
