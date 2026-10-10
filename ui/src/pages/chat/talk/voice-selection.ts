import {
  TALK_VOICE_CHANGE_TIMEOUT_MS,
  validateTalkVoiceChangeEvent,
  type TalkVoiceChangeEvent,
  type TalkVoiceCompleteParams,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";

export type RealtimeVoiceCall = { getVoiceSessionId(): string | undefined };
type VoiceChange = {
  request: TalkVoiceChangeEvent;
  started?: RealtimeVoiceCall;
  ready?: RealtimeVoiceCall;
  completing: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const VOICE_REQUEST_TIMEOUT_MS = TALK_VOICE_CHANGE_TIMEOUT_MS + 10_000;

export class RealtimeTalkVoiceSelection {
  private active = true;
  private change: VoiceChange | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly owner: {
      client: GatewayBrowserClient;
      sessionKey: string;
      isCurrent: () => boolean;
      currentCall: () => RealtimeVoiceCall | null;
      restart: (request: TalkVoiceChangeEvent) => Promise<RealtimeVoiceCall | undefined>;
      cancel: (message: string) => void;
    },
  ) {
    this.unsubscribe = owner.client.addEventListener((event) => {
      if (event.event === "talk.voice.change" && validateTalkVoiceChangeEvent(event.payload)) {
        this.receive(event.payload);
      }
    });
  }

  private current(call = this.owner.currentCall()): call is RealtimeVoiceCall {
    return (
      this.active && this.owner.isCurrent() && call !== null && this.owner.currentCall() === call
    );
  }

  ready(call: RealtimeVoiceCall) {
    if (!this.current(call)) {
      return;
    }
    const change = this.change;
    if (!change) {
      return;
    }
    if (call.getVoiceSessionId() === change.request.voiceSessionId) {
      return;
    }
    change.ready = call;
    this.completeReady(change);
  }

  failed(call: RealtimeVoiceCall) {
    if (this.current(call) && this.change) {
      this.fail(this.change, t("chat.voice.selectionFailed"));
    }
  }

  private receive(request: TalkVoiceChangeEvent) {
    if (!this.active || !this.owner.isCurrent() || request.sessionKey !== this.owner.sessionKey) {
      return;
    }
    if (request.phase === "cancelled") {
      const change = this.change;
      if (
        change?.request.changeId === request.changeId &&
        change.request.voiceSessionId === request.voiceSessionId
      ) {
        this.clearChange(change);
        this.owner.cancel(t("chat.voice.selectionFailed"));
      }
      return;
    }
    const current = this.owner.currentCall();
    if (
      !this.current(current) ||
      current.getVoiceSessionId() !== request.voiceSessionId ||
      this.change
    ) {
      return;
    }
    const change: VoiceChange = {
      request,
      completing: false,
      timer: setTimeout(
        () => this.fail(change, t("chat.voice.selectionTimedOut")),
        VOICE_REQUEST_TIMEOUT_MS,
      ),
    };
    this.change = change;
    void this.owner
      .restart(request)
      .then((call) => {
        if (this.change !== change || !this.active || !this.owner.isCurrent()) {
          return;
        }
        if (!call || !this.current(call)) {
          this.fail(change, t("chat.voice.selectionFailed"));
          return;
        }
        change.started = call;
        this.completeReady(change);
      })
      .catch(() => this.fail(change, t("chat.voice.selectionFailed")));
  }

  private clearChange(change: VoiceChange) {
    clearTimeout(change.timer);
    if (this.change === change) {
      this.change = undefined;
    }
  }

  private completeReady(change: VoiceChange) {
    const call = change.started;
    const voiceSessionId = call?.getVoiceSessionId();
    if (
      this.change !== change ||
      !call ||
      change.ready !== call ||
      !this.current(call) ||
      !voiceSessionId ||
      voiceSessionId === change.request.voiceSessionId ||
      change.completing
    ) {
      return;
    }
    change.completing = true;
    void this.complete(change, { voiceSessionId, outcome: "ready" })
      .then(() => {
        if (this.change === change && this.current(call)) {
          this.clearChange(change);
        }
      })
      .catch(() => this.fail(change, t("chat.voice.selectionConfirmationFailed")));
  }

  private fail(change: VoiceChange, error: string) {
    if (this.change !== change) {
      return;
    }
    this.clearChange(change);
    this.reportFailure(change, error);
    if (this.active && this.owner.isCurrent()) {
      this.owner.cancel(error);
    }
  }

  private reportFailure(change: VoiceChange, error: string) {
    const voiceSessionId = this.owner.currentCall()?.getVoiceSessionId();
    void this.complete(change, {
      ...(voiceSessionId && voiceSessionId !== change.request.voiceSessionId
        ? { voiceSessionId }
        : {}),
      outcome: "failed",
      error,
    }).catch(() => undefined);
  }

  private complete(
    change: VoiceChange,
    outcome: Omit<TalkVoiceCompleteParams, "changeId">,
  ): Promise<unknown> {
    return this.owner.client.request(
      "talk.voice.complete",
      { changeId: change.request.changeId, ...outcome },
      { timeoutMs: VOICE_REQUEST_TIMEOUT_MS },
    );
  }

  dispose() {
    this.active = false;
    this.unsubscribe();
    const change = this.change;
    if (change) {
      this.clearChange(change);
      this.reportFailure(change, t("common.cancelled"));
    }
  }
}
