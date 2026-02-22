import type { Bot } from "grammy";
import type { SubsystemLogger } from "../logging.js";

export interface HealthCheckResult {
  ok: boolean;
  latency: number;
  error?: string;
  at: number;
}

export type HealthConfig = {
  interval?: number;
  timeout?: number;
  failureThreshold?: number;
  onFail?: (reason: string) => void;
  onRecover?: () => void;
};

export class BotHealthCheck {
  private bot: Bot;
  private logger: SubsystemLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private lastOk = true;

  private interval: number;
  private timeout: number;
  private failureThreshold: number;
  private onFail?: (reason: string) => void;
  private onRecover?: () => void;

  constructor(bot: Bot, logger: SubsystemLogger, config: HealthConfig = {}) {
    this.bot = bot;
    this.logger = logger;
    this.interval = config.interval || 30000;
    this.timeout = config.timeout || 5000;
    this.failureThreshold = config.failureThreshold || 3;
    this.onFail = config.onFail;
    this.onRecover = config.onRecover;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.check().catch(() => {});
    this.timer = setInterval(() => {
      this.check().catch(() => {});
    }, this.interval);
  }

  stop() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), this.timeout),
      );
      await Promise.race([this.bot.api.getMe(), timeout]);

      const latency = Date.now() - start;

      if (this.failures > 0) {
        this.logger.info(`telegram health recovered`);
        this.onRecover?.();
        this.failures = 0;
      }
      this.lastOk = true;

      return { ok: true, latency, at: Date.now() };
    } catch (err) {
      this.failures++;
      const msg = err instanceof Error ? err.message : String(err);

      if (this.failures >= this.failureThreshold && this.lastOk) {
        this.logger.error(`telegram health check failed: ${msg}`);
        this.onFail?.(msg);
        this.lastOk = false;
      }

      return { ok: false, latency: Date.now() - start, error: msg, at: Date.now() };
    }
  }

  status() {
    return { ok: this.lastOk, failures: this.failures };
  }
}
