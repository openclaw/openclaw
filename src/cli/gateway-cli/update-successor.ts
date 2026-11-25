import type { ChildProcess } from "node:child_process";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { ForegroundUpdateStop } from "../../infra/update-managed-service-handoff.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { DEFAULT_RESTART_HEALTH_DELAY_MS } from "../daemon-cli/restart-health.constants.js";
import { sameManagedUpdateOwner, type GatewayRunSignalRequest } from "./run-loop-request.js";

export class GatewayUpdateSuccessor {
  private child: ChildProcess | true | null = null;
  private closed: Promise<void> | undefined;
  private foregroundStop?: {
    owner: ForegroundUpdateStop;
    confirmed: ReturnType<typeof createDeferredCore<void>>;
    onSettled: () => void;
    state: "waiting" | "joining" | "settled";
  };
  stopRequested = false;

  constructor(
    private readonly logger: Pick<SubsystemLogger, "info" | "warn" | "error">,
    private readonly lifecycle: Pick<
      typeof import("./lifecycle.runtime.js"),
      | "cancelManagedServiceUpdateHandoff"
      | "captureForegroundUpdateHandoffStop"
      | "completeForegroundUpdateHandoffAfterClose"
      | "markUpdateRestartSentinelFailure"
      | "waitForGatewayHttpReadiness"
    >,
  ) {}

  get committed(): boolean {
    return this.child !== null;
  }

  get waitingForStop(): boolean {
    return this.foregroundStop !== undefined && this.foregroundStop.state !== "settled";
  }

  get capturedStop(): boolean {
    return this.foregroundStop !== undefined;
  }

  get running(): boolean {
    const child = this.child;
    return Boolean(
      child && child !== true && child.pid && child.exitCode === null && child.signalCode === null,
    );
  }

  commit(child: ChildProcess | true): void {
    if (this.child === child) {
      return;
    }
    this.child = child;
    if (child !== true) {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.closed = Promise.resolve();
      } else {
        const { promise, resolve } = Promise.withResolvers<void>();
        child.once("close", resolve);
        this.closed = promise;
      }
    }
  }

  async observeReadiness(
    child: ChildProcess,
    params: {
      port?: number;
      host?: string;
      config?: OpenClawConfig;
      beforeWait: () => void;
    },
  ): Promise<boolean> {
    // Once spawned, only the launcher may recover or restore its trial. This
    // retiring process must not open any database, even to observe readiness.
    this.commit(child);
    if (child.exitCode !== null || child.signalCode !== null || params.port === undefined) {
      return false;
    }
    const controller = new AbortController();
    const onClose = () => controller.abort(new Error("Gateway launcher exited before readiness"));
    child.once("close", onClose);
    params.beforeWait();
    const { deadlineMs } = resolveGatewayStartupTiming();
    try {
      const readiness = await this.lifecycle.waitForGatewayHttpReadiness({
        port: params.port,
        host: params.host,
        config: params.config,
        attempts: Math.ceil(deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS),
        deadlineAt: performance.now() + deadlineMs,
        delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
        signal: controller.signal,
      });
      if (this.stopRequested || controller.signal.aborted) {
        return false;
      }
      if (readiness.healthz !== 200 || readiness.readyz !== 200) {
        this.logger.warn("update respawn is still starting; the launcher owns trial recovery");
      }
      this.logger.info(
        `restart mode: update process respawn (spawned pid ${child.pid ?? "unknown"})`,
      );
      return true;
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
      return false;
    } finally {
      child.off("close", onClose);
    }
  }

  stop(signal: "SIGINT" | "SIGTERM"): void {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.logger.info(`received ${signal}; stopping after foreground update settlement`);
      if (this.child && this.child !== true && this.running) {
        try {
          this.child.kill(signal);
        } catch (error) {
          this.logger.warn(`fresh Gateway stop signal failed: ${formatErrorMessage(error)}`);
        }
      }
    }
    this.joinForegroundStop();
  }

  private joinForegroundStop(): void {
    const pending = this.foregroundStop;
    if (!pending || pending.state !== "waiting") {
      return;
    }
    pending.state = "joining";
    void pending.owner
      .settle()
      .then((joined) => {
        if (!joined) {
          pending.state = "waiting";
          this.logger.error(
            "foreground update settlement unconfirmed; remaining draining; retry Stop after checking the updater",
          );
          return;
        }
        pending.state = "settled";
        pending.confirmed.resolve();
        pending.onSettled();
      })
      .catch((error: unknown) => {
        pending.state = "waiting";
        this.logger.error(`foreground update settlement failed: ${formatErrorMessage(error)}`);
      });
  }

  private retainForegroundStop(owner: ForegroundUpdateStop, onSettled: () => void): void {
    this.foregroundStop ??= {
      owner,
      confirmed: createDeferredCore(),
      onSettled,
      state: "waiting",
    };
  }

  async completeForegroundHandoffAfterClose(
    identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  ): Promise<{ respawn: boolean }> {
    const owner = this.lifecycle.captureForegroundUpdateHandoffStop({ onPark: () => {} });
    const completed = await this.lifecycle.completeForegroundUpdateHandoffAfterClose(identity);
    if (completed !== "pending") {
      return completed;
    }
    if (owner) {
      this.retainForegroundStop(owner, () => {});
    }
    const pending = this.foregroundStop;
    if (!pending) {
      throw new Error("foreground update settlement owner is unavailable; remaining draining");
    }
    // Retain settlement's lease worker before cancellation can finish and close it.
    this.joinForegroundStop();
    await this.cancelHandoff(() => identity);
    await pending.confirmed.promise;
    return { respawn: false };
  }

  async markHandoffUnavailable(
    foregroundClosed: boolean,
    reason = "restart-handoff-unavailable",
  ): Promise<void> {
    if (foregroundClosed) {
      return;
    }
    await this.lifecycle.markUpdateRestartSentinelFailure(reason).catch((error: unknown) => {
      this.logger.warn(`failed to mark update restart ${reason}: ${String(error)}`);
    });
  }

  handleSignal(
    request: Pick<GatewayRunSignalRequest, "action" | "signal" | "restartIntent">,
    foregroundActive: boolean | undefined,
    params: {
      beforeWait: () => void;
      onPark: (identity: NonNullable<GatewayRestartIntent["successorOwner"]>) => void;
      onSettled: () => void;
    },
  ): boolean {
    const { action, signal, restartIntent } = request;
    const successorOwner = restartIntent?.successorOwner;
    if (
      this.waitingForStop &&
      action !== "stop" &&
      (action !== "restart" ||
        !successorOwner ||
        !this.foregroundStop?.owner.canPark(successorOwner))
    ) {
      this.logger.info(
        `received ${signal}; ignoring restart while foreground update Stop is pending`,
      );
      return true;
    }
    if (action !== "stop" || signal === "SIGUSR2") {
      return false;
    }
    if (!foregroundActive && !this.waitingForStop) {
      if (this.foregroundStop) {
        return false;
      }
      const owner = this.lifecycle.captureForegroundUpdateHandoffStop({ onPark: params.onPark });
      if (!owner) {
        return false;
      }
      this.retainForegroundStop(owner, params.onSettled);
      params.beforeWait();
    }
    this.stop(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    return true;
  }

  async cancelHandoff(
    getOwner: () => GatewayRestartIntent["successorOwner"],
    initialOwner = getOwner(),
  ): Promise<false | "restored-in-process" | "restart-after-exit"> {
    let owner = initialOwner;
    let requiresParentExit = false;
    try {
      for (;;) {
        if (!owner) {
          return requiresParentExit ? "restart-after-exit" : "restored-in-process";
        }
        const restoration = await this.lifecycle.cancelManagedServiceUpdateHandoff(owner);
        if (!restoration) {
          this.logger.error("managed update handoff cancellation unconfirmed; remaining draining");
          return false;
        }
        requiresParentExit ||= restoration === "restart-after-exit";
        const replacement = getOwner();
        if (!replacement || sameManagedUpdateOwner(owner, replacement)) {
          return requiresParentExit ? "restart-after-exit" : "restored-in-process";
        }
        owner = replacement;
      }
    } catch (err) {
      this.logger.error(`managed update handoff cancellation failed: ${formatErrorMessage(err)}`);
      return false;
    }
  }

  async cancel(): Promise<void> {
    const child = this.child;
    if (child && child !== true && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        this.logger.warn(`fresh Gateway cancellation failed: ${formatErrorMessage(error)}`);
      }
    }
    await this.closed;
  }

  async waitForStopSettlement(): Promise<void> {
    if (this.stopRequested) {
      await this.foregroundStop?.confirmed.promise;
    }
  }

  async exit(code: number, exitProcess: (code: number) => void | Promise<void>): Promise<void> {
    await this.waitForStopSettlement();
    const exitCode = code === 0 && !this.stopRequested && !this.running ? 1 : code;
    if (exitCode !== code) {
      this.logger.error("fresh Gateway stopped before handoff completed; check its startup logs");
    }
    if (this.stopRequested || exitCode !== 0) {
      await this.closed;
    }
    await exitProcess(exitCode);
  }
}
