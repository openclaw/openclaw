import type { SessionKey } from "../sessions/session-key.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

type EnforcerState = {
  status: "armed" | "disarmed";
  lastActivityMs: number;
  reason: string;
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

  public onTranscriptUpdate(evt: {
    sessionKey: SessionKey;
    source: "user" | "agent";
    text?: string;
  }) {
    if (!this.config.enabled) {
      return;
    }

    if (evt.source === "user") {
      // User spoke -> Disarm immediately (It's the user's turn now)
      if (this.states.has(evt.sessionKey)) {
        this.setState(evt.sessionKey, "disarmed", "User message");
      }
    } else if (evt.source === "agent") {
      const text = evt.text?.trim();
      if (text === SILENT_REPLY_TOKEN || text === "NO_REPLY" || text === "HEARTBEAT_OK") {
        this.setState(evt.sessionKey, "disarmed", "Agent sign-off");
      } else {
        // Agent replied -> Reset timer AND ensure it is ARMED.
        // We want to track "time since last agent token".
        // If agent sends "Hello", timer starts.
        // If 30s pass without user reply or agent NO_REPLY -> Trigger.
        this.setState(evt.sessionKey, "armed", "Agent activity");
      }
    }
  }

  public onAgentLifecycle(evt: { sessionKey: SessionKey; phase: "start" | "end" | "error" }) {
    if (!this.config.enabled) {
      return;
    }

    if (evt.phase === "start") {
      // Do nothing on start. Wait for first token.
    } else if (evt.phase === "error") {
      // Only disarm on error. Normal "end" keeps it armed until explicit NO_REPLY token.
      this.setState(evt.sessionKey, "disarmed", `Lifecycle ${evt.phase}`);
      this.logger.debug("Chain DISARMED by lifecycle error", { key: evt.sessionKey });
    }
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
        this.logger.warn("Watchdog trigger!", { key, elapsed, timeout: this.config.timeoutMs });

        // Disarm to prevent loop
        this.setState(key, "disarmed", "Watchdog Triggered");

        // Fire recovery
        void this.runtime.runHeartbeatOnce({
          reason: "watchdog-stall",
          prompt: this.config.prompt,
          sessionKey: key,
        });
      }
    }
  }
}
