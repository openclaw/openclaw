import { SESSION_CREATE_RETRY_WINDOW_MS } from "../../../../packages/gateway-protocol/src/session-limits.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionCreateOutcome, SessionCreateParams } from "../../lib/sessions/create.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  formatTerminalChatSendAckError,
  isTerminalFailureChatSendAck,
  normalizeChatSendAck,
} from "../chat/chat-send-ack.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";

registerNewSessionSetupEnglish();

type DraftPreparationSnapshot = {
  context: ApplicationContext | null | undefined;
  client: GatewayBrowserClient | null;
  params: SessionCreateParams;
  access: SessionMethodAccess;
  changed: () => void;
};

type PreparedDictationSession = {
  client: GatewayBrowserClient;
  selection: string;
  request: Promise<SessionCreateOutcome | null>;
  key?: string;
};

type DraftSessionStartupIntent = DraftStartupResumption & {
  scope: string;
  interrupted: boolean;
  preparedDictation?: PreparedDictationSession;
};

/** A creation attempt the submission flow resumes after reconnecting. */
export type DraftStartupResumption = {
  params: SessionCreateParams;
  startedAt: number;
  background: boolean;
};

export class DraftSessionStartup {
  private request = new AbortController();
  private preparedDictation: PreparedDictationSession | null = null;

  private pending: DraftSessionStartupIntent | null = null;

  constructor(
    private readonly gateway: Pick<DraftGatewayState, "connected" | "sessionCreateScope">,
    private readonly readPreparation?: () => DraftPreparationSnapshot,
  ) {}

  private currentDictationPreparation(
    prepared = this.pending?.preparedDictation ?? this.preparedDictation,
  ) {
    const current = this.readPreparation?.();
    return current &&
      prepared?.client === current.client &&
      prepared.selection === JSON.stringify(current.params)
      ? prepared
      : null;
  }

  dictationSessionKey = (): string | undefined => this.currentDictationPreparation()?.key;

  async prepareDictationSession(): Promise<string> {
    const current = this.readPreparation?.();
    if (!current) {
      throw new Error(t("newSession.createFailed"));
    }
    const { context, client, params, access } = current;
    if (!context || !client || !access.allowed) {
      throw new Error(!access.allowed ? access.reason : t("newSession.createFailed"));
    }
    let prepared = this.currentDictationPreparation();
    if (!prepared) {
      prepared = {
        client,
        selection: JSON.stringify(params),
        request: context.sessions.createResult(params, {
          reconciliation: "background",
          signal: context.lifecycleAbortSignal,
        }),
      };
      this.preparedDictation = prepared;
    }
    const result = await prepared.request;
    if (!result || this.currentDictationPreparation() !== prepared) {
      if (this.preparedDictation === prepared) {
        this.preparedDictation = null;
      }
      throw new Error(context.sessions.state.error ?? t("newSession.createFailed"));
    }
    prepared.key = result.key;
    current.changed();
    return result.key;
  }

  private async startPreparedSession(
    prepared: PreparedDictationSession,
    params: SessionCreateParams,
    signal: AbortSignal,
  ): Promise<SessionCreateOutcome | null> {
    const created = await prepared.request;
    if (!created) {
      return null;
    }
    const runId = params.idempotencyKey ?? generateUUID();
    const ack = normalizeChatSendAck(
      await prepared.client.request(
        "chat.send",
        {
          sessionKey: created.key,
          agentId: params.agentId,
          message: params.message ?? "",
          mentions: params.mentions,
          attachments: params.attachments,
          idempotencyKey: runId,
        },
        { timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS, signal, retainSentResultOnAbort: true },
      ),
      runId,
    );
    if (isTerminalFailureChatSendAck(ack)) {
      return {
        key: created.key,
        initialRun: { status: "rejected", error: formatTerminalChatSendAckError(ack, "chat") },
      };
    }
    return { key: created.key, initialRun: { status: "started", runId: ack.runId } };
  }

  captureRequest(): AbortSignal {
    this.request.abort();
    this.request = new AbortController();
    return this.request.signal;
  }

  abortRequest(): void {
    this.request.abort();
  }

  clearPreparation(): void {
    this.preparedDictation = null;
  }

  create(
    context: ApplicationContext,
    params: SessionCreateParams,
    options: {
      pendingKey?: string;
      resumedParams?: SessionCreateParams;
      background: boolean;
      allowPrepared: boolean;
      signal: AbortSignal;
    },
  ): Promise<SessionCreateOutcome | null> {
    if (options.pendingKey) {
      return Promise.resolve({ key: options.pendingKey, initialRun: { status: "idle" } });
    }
    const requestParams = options.resumedParams ?? this.start(params, options.background);
    const prepared = options.allowPrepared ? this.currentDictationPreparation() : null;
    if (options.allowPrepared && this.pending?.preparedDictation && !prepared) {
      return Promise.resolve(null);
    }
    if (prepared && this.pending) {
      // The target belongs to the retry intent, not just the editable draft cache.
      this.pending.preparedDictation = prepared;
    }
    return prepared
      ? this.startPreparedSession(prepared, requestParams, options.signal)
      : context.sessions.createResult(requestParams, {
          reconciliation: "background",
          signal: options.signal,
        });
  }

  get active(): boolean {
    return this.pending !== null;
  }

  start(params: SessionCreateParams, background = false): SessionCreateParams {
    const scope = this.gateway.sessionCreateScope;
    if (!scope) {
      return params;
    }
    if (!this.pending) {
      const startedAt = Date.now();
      this.pending = {
        params: Object.freeze({ ...params, idempotencyKey: generateUUID() }),
        scope,
        startedAt,
        interrupted: false,
        background,
      };
    }
    return this.pending.params;
  }

  clear() {
    this.pending = null;
  }

  interrupt(): boolean {
    if (!this.pending || !this.matchesOwner()) {
      this.clear();
      return false;
    }
    this.pending.interrupted = true;
    return true;
  }

  retireChangedOwner(): boolean {
    if (!this.pending || this.matchesOwner()) {
      return false;
    }
    this.clear();
    return true;
  }

  resume():
    | { kind: "wait" | "expired" | "owner-changed" }
    | ({ kind: "resume" } & DraftStartupResumption) {
    if (!this.pending?.interrupted) {
      return { kind: "wait" };
    }
    if (Date.now() >= this.pending.startedAt + SESSION_CREATE_RETRY_WINDOW_MS) {
      this.clear();
      return { kind: "expired" };
    }
    if (!this.matchesOwner()) {
      this.clear();
      return { kind: "owner-changed" };
    }
    if (!this.gateway.connected) {
      return { kind: "wait" };
    }
    this.pending.interrupted = false;
    return {
      kind: "resume",
      params: this.pending.params,
      startedAt: this.pending.startedAt,
      background: this.pending.background,
    };
  }

  private matchesOwner(): boolean {
    return (
      this.pending?.scope === this.gateway.sessionCreateScope &&
      (!this.pending?.preparedDictation ||
        this.currentDictationPreparation(this.pending.preparedDictation) !== null)
    );
  }
}
