import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
type SessionKey = string;

type EnforcerState = {
  status: "armed" | "disarmed";
  lastActivityMs: number;
  reason: string;
  /** The final agent text that caused arming (for diagnostics). */
  armingText?: string;
  /** Timestamp of the arming event. */
  armedAtMs?: number;
};

export class ReplyChainEnforcer {
  private states = new Map<SessionKey, EnforcerState>();
  private timers = new Map<SessionKey, NodeJS.Timeout>();
  private recoveryRuns = new Set<SessionKey>();
  private logger = createSubsystemLogger("watchdog");

  constructor(
    private config: {
      enabled: boolean;
      timeoutMs: number;
      prompt: string;
    },
    private runtime: {
      nowMs: () => number;
      /**
       * Inject a system message into a specific session and trigger an agent turn.
       * This is NOT a heartbeat — it's a targeted nudge to recover a stalled reply chain.
       */
      injectSystemMessage: (opts: {
        sessionKey: SessionKey;
        message: string;
        reason: string;
      }) => Promise<void>;
    },
  ) {}

  public updateConfig(newConfig: Partial<typeof this.config>) {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...newConfig };
    if (!this.config.enabled && wasEnabled) {
      this.stopAll();
      this.states.clear();
    }
  }

  public stopAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Agent is streaming — proof of life. Disarm and touch timer.
   * Called on every chat delta (throttled by the 150ms dedup in server-chat).
   */
  public onChatDelta(sessionKey: SessionKey) {
    if (!this.config.enabled) {
      return;
    }
    // Only log transition, not every delta
    const prev = this.states.get(sessionKey);
    if (prev?.status === "armed") {
      this.logger.info("DISARM (delta received while armed)", { key: sessionKey });
    }
    this.setState(sessionKey, "disarmed", "Agent streaming (delta)");
  }

  /**
   * Agent finished its turn — the assembled final message.
   * ARM if it said something meaningful. DISARM if it signed off.
   */
  public onChatFinal(sessionKey: SessionKey, text: string) {
    if (!this.config.enabled) {
      return;
    }

    // Don't re-arm from watchdog recovery runs — they're fire-and-forget
    if (this.recoveryRuns.has(sessionKey)) {
      this.recoveryRuns.delete(sessionKey);
      this.logger.info("DISARM (watchdog recovery run complete)", {
        key: sessionKey,
        textPreview: (text?.trim() ?? "").slice(0, 120),
      });
      this.setState(sessionKey, "disarmed", "Watchdog recovery complete");
      return;
    }

    const trimmed = text?.trim() ?? "";
    if (
      !trimmed ||
      trimmed === SILENT_REPLY_TOKEN ||
      trimmed === "NO_REPLY" ||
      trimmed === "HEARTBEAT_OK" ||
      trimmed.endsWith(SILENT_REPLY_TOKEN) ||
      trimmed.endsWith("NO_REPLY")
    ) {
      this.logger.info("DISARM (agent sign-off)", {
        key: sessionKey,
        signOff: trimmed.slice(0, 40) || "(empty)",
      });
      this.setState(sessionKey, "disarmed", "Agent sign-off");
    } else {
      const now = this.runtime.nowMs();
      this.logger.info("ARM (agent final message without sign-off)", {
        key: sessionKey,
        textPreview: trimmed.slice(0, 120),
        timeoutMs: this.config.timeoutMs,
      });
      this.setState(
        sessionKey,
        "armed",
        "Agent finished (awaiting follow-up)",
        trimmed.slice(0, 200),
        now,
      );
    }
  }

  public onAgentLifecycle(evt: { sessionKey: SessionKey; phase: "start" | "end" | "error" }) {
    if (!this.config.enabled) {
      return;
    }

    if (evt.phase === "error") {
      // On error, keep armed — the agent crashed mid-work and may not have
      // communicated results. The watchdog should fire if nothing follows.
      this.touchActivity(evt.sessionKey);
      this.logger.warn("Lifecycle error — staying armed", { key: evt.sessionKey });
    }
    // phase === "start" → do nothing. Deltas will disarm when they arrive.
    // phase === "end" → do nothing. onChatFinal already handled arm/disarm.
  }

  private setState(
    key: SessionKey,
    status: "armed" | "disarmed",
    reason: string,
    armingText?: string,
    armedAtMs?: number,
  ) {
    const now = this.runtime.nowMs();
    this.states.set(key, {
      status,
      lastActivityMs: now,
      reason,
      armingText,
      armedAtMs,
    });

    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(key);
    }

    if (status === "armed") {
      const timer = setTimeout(() => this.trigger(key), this.config.timeoutMs);
      this.timers.set(key, timer);
    }
  }

  private touchActivity(key: SessionKey) {
    const state = this.states.get(key);
    if (state && state.status === "armed") {
      state.lastActivityMs = this.runtime.nowMs();
      // Reset the timer since we touched activity
      const existingTimer = this.timers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      const timer = setTimeout(() => this.trigger(key), this.config.timeoutMs);
      this.timers.set(key, timer);
    }
  }

  private trigger(key: SessionKey) {
    if (!this.config.enabled) {
      return;
    }

    this.timers.delete(key);
    const state = this.states.get(key);

    if (!state || state.status !== "armed") {
      return; // Should not happen if timers are managed correctly, but safe
    }

    const now = this.runtime.nowMs();
    const elapsed = now - state.lastActivityMs;

    this.logger.warn("TRIGGER — stall detected", {
      key,
      elapsed,
      timeout: this.config.timeoutMs,
      armedAtMs: state.armedAtMs,
      armedAtISO: state.armedAtMs ? new Date(state.armedAtMs).toISOString() : undefined,
      armingReason: state.reason,
      armingText: state.armingText,
      targetSession: key,
    });

    // Disarm to prevent immediate re-trigger
    this.setState(key, "disarmed", "Watchdog Triggered");

    // Mark this session as having an active recovery run
    // so onChatFinal won't re-arm when the response arrives
    this.recoveryRuns.add(key);

    // Fire recovery — inject a system message directly into the stalled session.
    // This does NOT go through the heartbeat runner — it's a targeted nudge only.
    void this.runtime.injectSystemMessage({
      sessionKey: key,
      message: this.config.prompt,
      reason: "watchdog-stall",
    });
  }
}
