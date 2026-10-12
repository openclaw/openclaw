import { html, nothing } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { keyed } from "lit/directives/keyed.js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { icons } from "../../../components/icons.ts";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { ActivityHeadline } from "./chat-activity-headline-selection.ts";
import { renderToolIcon } from "./chat-tool-cards.ts";

const HEADLINE_HOLD_MS = 3_000;

/** One disclosure owns its readable cadence; fast calls replace pending copy, not a queue. */
class ActivityHeadlineDirective extends AsyncDirective {
  private scope = "";
  private pluginToolIcons?: PluginToolIcons;
  private summary = "";
  private outcomes: readonly string[] = [];
  private shown: ActivityHeadline | undefined;
  private pending: ActivityHeadline | undefined;
  private shownAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  override render(
    scope: string,
    activity: ActivityHeadline | undefined,
    summary: string,
    currentActivity?: readonly AgentActivityItem[],
    pluginToolIcons?: PluginToolIcons,
    outcomes: readonly string[] = [],
  ) {
    this.pluginToolIcons = pluginToolIcons;
    this.summary = summary;
    this.outcomes = outcomes;
    const reset = this.scope !== scope;
    this.scope = scope;
    if (reset) {
      this.shown = undefined;
    }
    this.clearTimer();
    this.pending = undefined;
    if (!activity) {
      this.shown = undefined;
      return this.content();
    }
    const urgent = activity.status === "failed" || activity.status === "blocked";
    const remaining = HEADLINE_HOLD_MS - (Date.now() - this.shownAt);
    if (reset || !this.shown || urgent || this.shown.key === activity.key || remaining <= 0) {
      this.show(activity);
    } else {
      // Tool completion and the next start can arrive in one render. Holding
      // the old purpose must not also hold its obsolete running state.
      if (currentActivity && this.shown) {
        const current = currentActivity.find(
          (item) => (item.toolCallId ?? item.itemId) === this.shown?.key,
        );
        this.shown = { ...this.shown, status: current?.status };
      }
      this.pending = activity;
      if (this.isConnected) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (this.pending) {
            this.show(this.pending);
            this.pending = undefined;
            this.setValue(this.content());
          }
        }, remaining);
      }
    }
    return this.content();
  }

  private show(activity: ActivityHeadline) {
    if (this.shown?.key !== activity.key || this.shown.title !== activity.title) {
      this.shownAt = Date.now();
    }
    this.shown = activity;
  }

  private content() {
    const activity = this.shown;
    const name = activity?.name;
    // Icon and purpose share the same dwell, including asynchronous tool switches.
    return html`
      <span
        class="chat-activity-group__icon"
        role=${name ? "img" : nothing}
        aria-label=${name ?? nothing}
        aria-hidden=${name ? nothing : "true"}
        title=${name ?? nothing}
        >${name ? renderToolIcon(activity?.commandBearing ? "squareTerminal" : resolveToolDisplayIcon(name), { toolName: name, pluginToolIcons: this.pluginToolIcons }) : icons.listTree}</span
      >
      <span class="chat-tool-disclosure__content">
        ${
          // A step with no title of its own leaves the row reading as its count,
          // not as a lone icon.
          activity?.title
            ? keyed(
                activity.title,
                html`<span class="chat-activity-group__label chat-activity-group__label--live"
                  >${activity.title}${activity.status === "running" ? "…" : ""}</span
                >`,
              )
            : html`<span class="chat-activity-group__label">${this.summary}</span>`
        }
      </span>
      ${
        // The count line already carries these when it stands in for the
        // headline, so they follow the headline this row is showing, held or not.
        activity?.title
          ? this.outcomes.map(
              (label) => html`<span class="chat-activity-group__outcome muted">${label}</span>`,
            )
          : nothing
      }
    `;
  }

  private clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  protected override disconnected() {
    this.clearTimer();
  }

  protected override reconnected() {
    if (this.pending) {
      this.show(this.pending);
      this.pending = undefined;
      this.setValue(this.content());
    }
  }
}

export const activityHeadline = directive(ActivityHeadlineDirective);
