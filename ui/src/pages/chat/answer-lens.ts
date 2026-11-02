import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  readAnswerLensPreference,
  rememberAnswerLensPreference,
} from "./answer-lens-preference.ts";

export type AnswerLensSettings = {
  coverage: "gist" | "condensed" | "full";
  wording: "plain" | "clearer" | "technical" | "original";
};
export type AnswerLensSource = { messageId: string; text: string };
export type AnswerLensResult = AnswerLensSettings & {
  text: string;
  sourceRevision: string;
  messageId: string;
  model?: string;
  durationMs: number;
};
export const ORIGINAL_LENS: AnswerLensSettings = { coverage: "full", wording: "original" };

type Scope = {
  client:
    | (Pick<GatewayBrowserClient, "request"> &
        Partial<Pick<GatewayBrowserClient, "addEventListener">>)
    | null;
  epoch?: number;
  policyEpoch?: number;
  sessionKey: string;
  agentId?: string;
  latestMessageId?: string | null;
};
export type AnswerLensEntry = {
  source: AnswerLensSource;
  target: AnswerLensSettings;
  baseline?: AnswerLensResult;
  displayed?: AnswerLensResult;
  partialText?: string;
  pending?: { requestId: string; controller: AbortController };
  error?: string;
  cached: boolean;
  model?: string;
  variants: Map<string, AnswerLensResult>;
};

/** Private presentation only: stores a level preference, never answer text or conversation turns. */
export class AnswerLens {
  private scope: Scope = { client: null, sessionKey: "" };
  private preference = readAnswerLensPreference() ?? ORIGINAL_LENS;
  private latestMessageId: string | null | undefined;
  private readonly entries = new Map<string, AnswerLensEntry>();
  private readonly listeners = new Set<() => void>();

  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    return () => this.listeners.delete(notify);
  };

  configure(scope: Scope) {
    this.latestMessageId = scope.latestMessageId;
    if (
      this.scope.client !== scope.client ||
      this.scope.epoch !== scope.epoch ||
      this.scope.policyEpoch !== scope.policyEpoch ||
      this.scope.sessionKey !== scope.sessionKey ||
      this.scope.agentId !== scope.agentId
    ) {
      this.clear();
      this.scope = scope;
    }
  }

  read(source: AnswerLensSource | undefined): AnswerLensEntry | undefined {
    const entry = source && this.entries.get(source.messageId);
    return entry?.source.text === source?.text ? entry : undefined;
  }

  async applyRemembered(source: AnswerLensSource): Promise<void> {
    if (source.messageId !== this.latestMessageId || this.read(source)) {
      return;
    }
    const settings = readAnswerLensPreference() ?? this.preference;
    if (settings.wording === "original") {
      return;
    }
    await this.select(
      source,
      {
        ...settings,
        coverage: source.text.length < 160 ? "full" : settings.coverage,
      },
      false,
    );
  }

  private publish() {
    for (const notify of this.listeners) {
      notify();
    }
  }

  private cancel(entry: AnswerLensEntry) {
    const pending = entry.pending;
    entry.pending = undefined;
    entry.partialText = undefined;
    if (pending) {
      pending.controller.abort();
      // Cancellation is best effort; exact entry/request identity also rejects late replies.
      void this.scope.client
        ?.request("chat.answer.cancel", { requestId: pending.requestId })
        .catch(() => {});
    }
  }

  clear() {
    for (const entry of this.entries.values()) {
      this.cancel(entry);
    }
    this.entries.clear();
    this.publish();
  }

  async select(
    source: AnswerLensSource,
    settings: AnswerLensSettings,
    remember = true,
  ): Promise<void> {
    if (remember) {
      this.preference = settings;
      rememberAnswerLensPreference(settings);
    }
    const scope = this.scope;
    if (!scope.client) {
      return;
    }
    let entry = this.read(source);
    if (!entry) {
      const previous = this.entries.get(source.messageId);
      if (previous) {
        this.cancel(previous);
      }
      // At most 24 visited answers, with at most nine generated variants each.
      if (this.entries.size >= 24) {
        const oldest = this.entries.entries().next().value;
        if (oldest) {
          this.cancel(oldest[1]);
          this.entries.delete(oldest[0]);
        }
      }
      entry = { source, target: ORIGINAL_LENS, cached: false, variants: new Map() };
      this.entries.set(source.messageId, entry);
    }
    this.cancel(entry);
    entry.target = settings;
    entry.error = undefined;
    if (settings.coverage === "full" && settings.wording === "original") {
      entry.displayed = undefined;
      entry.cached = true;
      this.publish();
      return;
    }
    const settingsKey = `${settings.coverage}:${settings.wording}`;
    const cached =
      entry.baseline &&
      entry.variants.get(`${entry.baseline.sourceRevision}:${entry.model}:${settingsKey}`);
    if (cached) {
      entry.displayed = cached;
      entry.cached = true;
      this.publish();
      return;
    }
    const pending = { requestId: generateUUID(), controller: new AbortController() };
    entry.pending = pending;
    entry.cached = false;
    this.publish();
    const current = () =>
      this.scope === scope &&
      this.entries.get(source.messageId) === entry &&
      entry.pending === pending;
    const request = (target: AnswerLensSettings, sourceRevision?: string) =>
      scope.client!.request<AnswerLensResult>(
        "chat.answer.transform",
        {
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
          messageId: source.messageId,
          requestId: pending.requestId,
          sourceRevision,
          ...target,
        },
        { signal: pending.controller.signal, timeoutMs: 65_000 },
      );
    const detach = scope.client.addEventListener?.((event) => {
      if (event.event !== "chat.answer.delta" || !current()) {
        return;
      }
      const payload = asOptionalRecord(event.payload);
      if (
        payload?.requestId !== pending.requestId ||
        payload.messageId !== source.messageId ||
        payload.sourceRevision !== entry.baseline?.sourceRevision ||
        payload.coverage !== settings.coverage ||
        payload.wording !== settings.wording ||
        typeof payload.text !== "string" ||
        payload.text.length > 48_000
      ) {
        return;
      }
      entry.partialText = payload.text;
      this.publish();
    });
    try {
      if (!entry.baseline) {
        const baseline = await request(ORIGINAL_LENS);
        if (!current()) {
          return;
        }
        entry.baseline = baseline;
      }
      const result = await request(settings, entry.baseline.sourceRevision);
      if (!current()) {
        return;
      }
      // The server owns source identity and utility selection; don't mix models in a cache.
      if (entry.model && entry.model !== result.model) {
        entry.variants.clear();
      }
      entry.model = result.model;
      entry.variants.set(`${result.sourceRevision}:${result.model}:${settingsKey}`, result);
      entry.displayed = result;
    } catch (error) {
      if (current()) {
        if (
          error instanceof GatewayProtocolRequestError &&
          asOptionalRecord(error.details)?.code === "ANSWER_LENS_SOURCE_CHANGED"
        ) {
          entry.baseline = undefined;
          entry.displayed = undefined;
          entry.variants.clear();
        }
        entry.error = formatUiError(error);
      }
    } finally {
      detach?.();
      if (current()) {
        entry.pending = undefined;
        entry.partialText = undefined;
        this.publish();
      }
    }
  }
}
