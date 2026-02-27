/**
 * Idle detector for marketplace capacity sharing.
 *
 * Monitors whether the user is actively using Claude CLI tools.
 * When idle for longer than the configured threshold, reports
 * "idle" status to the gateway so marketplace requests can be routed here.
 */
import { execSync } from "node:child_process";
import type { GatewayClient } from "../gateway/client.js";
import type { MarketplaceIdleStatus } from "../gateway/marketplace/events.js";
import type { NodeHostMarketplaceConfig } from "./config.js";

/** Process names known to use Claude/AI API keys. */
const DEFAULT_WATCH_PROCESSES = [
  "claude",
  "cursor",
  "aider",
  "continue",
  "cody",
  "copilot",
  "windsurf",
];

/** Host that indicates active Claude API usage. */
const ANTHROPIC_API_HOST = "api.anthropic.com";

const DEFAULT_IDLE_THRESHOLD_SEC = 300;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export class IdleDetector {
  private status: MarketplaceIdleStatus = "active";
  private lastActiveAtMs: number = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly client: GatewayClient;
  private readonly config: NodeHostMarketplaceConfig;
  private readonly idleThresholdMs: number;

  constructor(client: GatewayClient, config: NodeHostMarketplaceConfig) {
    this.client = client;
    this.config = config;
    this.idleThresholdMs = (config.idleThresholdSec ?? DEFAULT_IDLE_THRESHOLD_SEC) * 1000;
  }

  /** Start polling for activity. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), DEFAULT_POLL_INTERVAL_MS);
  }

  /** Stop the detector and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get current marketplace idle status. */
  getStatus(): MarketplaceIdleStatus {
    return this.status;
  }

  /** Mark this node as actively handling a marketplace request. */
  setSharing(): void {
    this.setStatus("sharing");
  }

  /** Release from sharing back to normal detection. */
  releaseSharing(): void {
    // Re-evaluate immediately
    this.poll();
  }

  private poll(): void {
    const isActive = this.detectActivity();
    if (isActive) {
      this.lastActiveAtMs = Date.now();
    }

    const elapsed = Date.now() - this.lastActiveAtMs;
    const shouldBeIdle = !isActive && elapsed >= this.idleThresholdMs;

    if (this.status === "sharing") {
      // Don't change status while actively processing marketplace requests.
      // But if the user became active, the gateway will be notified on the
      // next status change after sharing completes.
      return;
    }

    const newStatus: MarketplaceIdleStatus = shouldBeIdle ? "idle" : "active";
    if (newStatus !== this.status) {
      this.setStatus(newStatus);
    }
  }

  private setStatus(status: MarketplaceIdleStatus): void {
    const prev = this.status;
    this.status = status;
    // eslint-disable-next-line no-console
    console.error(`[marketplace] idle status: ${prev} → ${status}`);
    this.reportStatus();
  }

  private reportStatus(): void {
    try {
      void this.client.request("node.event", {
        event: "marketplace.idle.status",
        payloadJSON: JSON.stringify({
          status: this.status,
          lastActiveAtMs: this.lastActiveAtMs,
        }),
      });
    } catch {
      // Fire-and-forget — gateway may not be connected yet.
    }
  }

  /**
   * Detect if any Claude CLI tools are currently running.
   * Returns true if activity is detected.
   */
  private detectActivity(): boolean {
    return this.detectWatchedProcesses() || this.detectAnthropicConnections();
  }

  /** Check if any watched Claude-related processes are running. */
  private detectWatchedProcesses(): boolean {
    try {
      if (process.platform === "win32") {
        const out = execSync("tasklist /FO CSV /NH", {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const lower = out.toLowerCase();
        return DEFAULT_WATCH_PROCESSES.some((p) => lower.includes(p));
      }

      // macOS / Linux: use pgrep
      for (const name of DEFAULT_WATCH_PROCESSES) {
        try {
          execSync(`pgrep -x "${name}"`, {
            timeout: 3000,
            stdio: ["ignore", "ignore", "ignore"],
          });
          return true;
        } catch {
          // pgrep returns exit code 1 when no match — not an error.
        }
      }
      return false;
    } catch {
      // If process detection fails, assume active (fail-safe).
      return true;
    }
  }

  /** Check for active outbound connections to Anthropic API. */
  private detectAnthropicConnections(): boolean {
    try {
      if (process.platform === "win32") {
        const out = execSync(`netstat -an | findstr "${ANTHROPIC_API_HOST}"`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out.trim().length > 0;
      }

      // macOS: lsof is reliable for checking network connections.
      // Linux: ss is faster.
      const cmd =
        process.platform === "darwin"
          ? `lsof -i -n -P 2>/dev/null | grep -i "${ANTHROPIC_API_HOST}"`
          : `ss -tnp 2>/dev/null | grep -i "${ANTHROPIC_API_HOST}"`;

      const out = execSync(cmd, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim().length > 0;
    } catch {
      // grep/ss returns exit code 1 when no match.
      return false;
    }
  }
}
