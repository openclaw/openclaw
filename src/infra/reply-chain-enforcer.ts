import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionKey } from "../sessions/session-key.js";

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
  private timer: NodeJS.Timeout | null = null;
  private logger = createSubsystemLogger("watchdog");

  constructor(
    private config: {
      enabled: boolean;
      timeoutMs: number;
      prompt: string;
    },
    private runtime: {
      nowMs: () => number;
      runHeartbeatOnce: (opts: {
        reason: string;
        prompt: string;
        sessionKey: SessionKey;
        noFallback?: boolean;
      }) => Promise<void>;
    },
  ) {}

  public updateConfig(newConfig: Partial<typeof this.config>) {
    this.config = { ...this.config, ...newConfig };
    if (!this.config.enabled) {
      this.stop();
      this.states.clear();
    } else if (!this.timer) {
      this.start();
    }
  }

  public start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.check(), 5000); // Check every 5s
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
      this.states.set(sessionKey, {
        status: "armed",
        lastActivityMs: now,
        reason: "Agent finished (awaiting follow-up)",
        armingText: trimmed.slice(0, 200),
        armedAtMs: now,
      });
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

  private setState(key: SessionKey, status: "armed" | "disarmed", reason: string) {
    this.states.set(key, {
      status,
      lastActivityMs: this.runtime.nowMs(),
      reason,
    });
  }

  private touchActivity(key: SessionKey) {
    const state = this.states.get(key);
    if (state) {
      state.lastActivityMs = this.runtime.nowMs();
    }
  }

  private check() {
    if (!this.config.enabled) {
      return;
    }
    const now = this.runtime.nowMs();

    for (const [key, state] of this.states.entries()) {
      if (state.status !== "armed") {
        continue;
      }

      const elapsed = now - state.lastActivityMs;
      if (elapsed > this.config.timeoutMs) {
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

        // Fire recovery — noFallback prevents redirecting to main session
        // if the target session isn't in the store (avoids spamming wrong session)
        void this.runtime.runHeartbeatOnce({
          reason: "watchdog-stall",
          prompt: this.config.prompt,
          sessionKey: key,
          noFallback: true,
        });
      }
    }
  }
}
