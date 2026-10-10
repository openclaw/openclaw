import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { Value } from "typebox/value";
import {
  SessionObserverDigestSchema,
  type SessionObserverDigest,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { pickFreshestObserverDigest } from "../../../lib/observer-digest.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  resolveUiSessionRowAgentId,
} from "../../../lib/sessions/session-key.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import { renderSubagentActivity } from "./chat-subagent-activity.ts";

/** A view cache of the broad session observer stream, not a child-history subscriber. */
export class ChatSubagentActivityLive extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  context!: ApplicationContext;
  @property({ attribute: false }) rows: readonly ChatSubagentActivity[] = [];
  @property({ attribute: false }) onOpenSubagent?: (key: string) => void;
  @property({ attribute: false }) onOpenSession?: (key: string) => void;

  private boundContext?: ApplicationContext;
  private connection: object | null = null;
  private cleanup: Array<() => void> = [];
  private digests = new Map<string, SessionObserverDigest>();

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.retire();
    super.disconnectedCallback();
  }

  private retire(): void {
    for (const unsubscribe of this.cleanup) {
      unsubscribe();
    }
    this.cleanup = [];
    this.boundContext = undefined;
    this.connection = null;
    this.digests.clear();
  }

  private matchesRun(row: ChatSubagentActivity, digest: SessionObserverDigest): boolean {
    const session = row.session;
    return (
      row.status === "running" &&
      areUiSessionKeysEquivalent(row.key, digest.sessionKey) &&
      typeof digest.runId === "string" &&
      session.activeRunIds?.includes(digest.runId) === true &&
      (!digest.agentId ||
        normalizeAgentId(digest.agentId) === resolveUiSessionRowAgentId(session, "")) &&
      (!digest.sessionId || digest.sessionId === session.sessionId) &&
      (!digest.lifecycleRevision || digest.lifecycleRevision === session.lifecycleRevision)
    );
  }

  protected override willUpdate(_changed: PropertyValues<this>): void {
    // Lit can finish an already queued update after removal. It must not
    // reacquire listeners that disconnectedCallback just released.
    if (!this.isConnected) {
      return;
    }
    if (this.boundContext !== this.context) {
      this.retire();
      const context = this.context;
      this.boundContext = context;
      if (context) {
        this.connection = context.gateway.snapshot.hello;
        this.cleanup = [
          context.gateway.subscribe(() => {
            if (this.connection !== context.gateway.snapshot.hello) {
              this.connection = context.gateway.snapshot.hello;
              this.digests.clear();
              this.requestUpdate();
            }
          }),
          context.gateway.subscribeEvents((event) => {
            if (
              event.event !== "session.observer" ||
              !this.connection ||
              this.connection !== context.gateway.snapshot.hello ||
              !Value.Check(SessionObserverDigestSchema, event.payload)
            ) {
              return;
            }
            const digest = event.payload;
            const row = this.rows.find((candidate) => this.matchesRun(candidate, digest));
            if (!row || pickFreshestObserverDigest(this.digests.get(row.key), digest) !== digest) {
              return;
            }
            this.digests.set(row.key, digest);
            this.requestUpdate();
          }),
        ];
      }
    }
    for (const [key, digest] of this.digests) {
      if (!this.rows.some((row) => row.key === key && this.matchesRun(row, digest))) {
        this.digests.delete(key);
      }
    }
  }

  override render() {
    return renderSubagentActivity(
      this.rows.map((row) => {
        const live = this.digests.get(row.key);
        if (!live || !this.matchesRun(row, live)) {
          return row;
        }
        const stored = row.session.observerDigest;
        const digest = pickFreshestObserverDigest(
          live,
          stored?.runId === live.runId ? stored : undefined,
        );
        return { ...row, activity: digest?.headline.trim() || undefined };
      }),
      this.onOpenSubagent,
      this.onOpenSession,
    );
  }
}

if (!customElements.get("openclaw-chat-subagent-activity")) {
  customElements.define("openclaw-chat-subagent-activity", ChatSubagentActivityLive);
}
