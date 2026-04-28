import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onAgentEvent, type AgentEventPayload } from "./agent-events.js";
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
  /**
   * Accumulate raw assistant text per runId (including NO_REPLY tokens that
   * the upstream execution layer strips before server-chat sees them).
   * On lifecycle:end we check this buffer for sign-off tokens and call
   * onChatFinal ourselves, making the watchdog self-contained.
   */
  private runBuffers = new Map<string, { sessionKey: SessionKey; text: string }>();
  /** Sessions force-DISARMed by raw stream sign-off detection. Prevents onChatFinal from re-ARMing. */
  private rawSignOffSessions = new Set<SessionKey>();
  private agentEventUnsub: (() => void) | null = null;

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
  ) {
    this.startAgentEventListener();
  }

  /**
   * Subscribe to the global agent event bus to independently track assistant
   * text and lifecycle events. This lets the watchdog see the FULL agent output
   * (including NO_REPLY tokens stripped by the execution layer) and decide
   * ARM/DISARM without depending on server-chat's buffer.
   */
  private startAgentEventListener() {
    this.agentEventUnsub = onAgentEvent((evt: AgentEventPayload) => {
      if (!this.config.enabled) {
        return;
      }

      const sessionKey = evt.sessionKey;
      if (!sessionKey) {
        this.logger.debug?.("raw-listener: no sessionKey", {
          runId: evt.runId?.slice(0, 8),
          stream: evt.stream,
        });
        return;
      }

      // Accumulate assistant text per run (text is cumulative in streaming)
      if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
        const existing = this.runBuffers.get(evt.runId);
        if (existing) {
          existing.text = evt.data.text;
        } else {
          this.runBuffers.set(evt.runId, { sessionKey, text: evt.data.text });
        }
        return;
      }

      // Handle explicit signoff events (emitted when parseReplyDirectives strips
      // a silent reply token like NO_REPLY or HEARTBEAT_OK)
      if (evt.stream === "signoff" && evt.data?.token) {
        this.logger.info("DISARM (signoff event received)", {
          key: sessionKey,
          token: evt.data.token,
        });
        this.rawSignOffSessions.add(sessionKey);
        this.setState(sessionKey, "disarmed", "Agent sign-off (signoff event)");
        this.runBuffers.delete(evt.runId);
        return;
      }

      // Handle abort events (emitted by /stop command).
      // Disarm the watchdog so a stale timer doesn't inject a stall-recovery
      // message after the user explicitly stopped the agent.
      if (evt.stream === "abort") {
        this.logger.info("DISARM (abort event received)", { key: sessionKey });
        this.rawSignOffSessions.add(sessionKey);
        this.setState(sessionKey, "disarmed", "Agent aborted (/stop)");
        return;
      }

      // On lifecycle:end, check our own buffer for sign-off
      if (evt.stream === "lifecycle" && evt.data?.phase === "end") {
        const buf = this.runBuffers.get(evt.runId);
        this.runBuffers.delete(evt.runId);
        if (buf) {
          const trimmed = buf.text.trim();
          // The streaming handler strips full NO_REPLY via parseReplyDirectives
          // before emitting assistant events, so we may only see partial prefixes
          // like "NO" when the model actually said "NO_REPLY". Check full tokens
          // AND whether the entire buffer is a known sign-off prefix.
          const NO_REPLY_PREFIXES = [
            "N",
            "NO",
            "NO_",
            "NO_R",
            "NO_RE",
            "NO_REP",
            "NO_REPL",
            "NO_REPLY",
          ];
          const HEARTBEAT_PREFIXES = [
            "H",
            "HE",
            "HEA",
            "HEAR",
            "HEART",
            "HEARTB",
            "HEARTBE",
            "HEARTBEA",
            "HEARTBEAT",
            "HEARTBEAT_",
            "HEARTBEAT_O",
            "HEARTBEAT_OK",
          ];
          const SIGN_OFF_TOKENS = [...NO_REPLY_PREFIXES, ...HEARTBEAT_PREFIXES, SILENT_REPLY_TOKEN];
          const isSignOff =
            !trimmed ||
            trimmed.endsWith("NO_REPLY") ||
            trimmed.endsWith(SILENT_REPLY_TOKEN) ||
            trimmed === "HEARTBEAT_OK" ||
            SIGN_OFF_TOKENS.includes(trimmed);
          if (isSignOff) {
            this.logger.info("DISARM (sign-off prefix match in raw stream — fallback)", {
              key: buf.sessionKey,
              buffer: trimmed.slice(-30),
              len: trimmed.length,
            });
            this.rawSignOffSessions.add(buf.sessionKey);
            this.setState(buf.sessionKey, "disarmed", "Agent sign-off (raw stream)");
          }
        }
        return;
      }

      // Clean up on error too
      if (evt.stream === "lifecycle" && evt.data?.phase === "error") {
        this.runBuffers.delete(evt.runId);
      }
    });
  }

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
    this.runBuffers.clear();
    this.rawSignOffSessions.clear();
    this.agentEventUnsub?.();
    this.agentEventUnsub = null;
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

    // If raw stream listener already detected sign-off, don't re-arm
    if (this.rawSignOffSessions.delete(sessionKey)) {
      this.logger.info("DISARM (onChatFinal skipped — raw stream already signed off)", {
        key: sessionKey,
      });
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
