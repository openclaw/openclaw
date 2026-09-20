import { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForksPoolWorker, type PoolOptions, type WorkerRequest } from "vitest/node";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { collectNodeDiagnosticReport } from "../../scripts/lib/node-diagnostic-report.mts";
import { collectVitestForkOsDiagnostics } from "../../scripts/lib/vitest-fork-os-diagnostics.mts";

const POOL_NAME = "openclaw-forks";
const MAX_REPORT_CHARS = 64 * 1_024;

class DiagnosticForksPoolWorker extends ForksPoolWorker {
  override readonly name = POOL_NAME;
  private child?: ChildProcess;
  private reportDir?: string;
  private stopRequested = false;
  private stopAcknowledged = false;
  private exitEntryReset = false;
  private diagnosticTimer?: NodeJS.Timeout;
  private diagnostics?: Promise<void>;
  private files: string[] = [];
  private readonly project: PoolOptions["project"];

  constructor(options: PoolOptions) {
    super(options);
    this.project = options.project;
  }

  override async start(): Promise<void> {
    if (process.platform !== "win32" && !process.versions.bun) {
      try {
        // openclaw-temp-dir: allow pool-owned diagnostics outlive individual test hooks.
        this.reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-report-"));
        this.execArgv = [
          ...this.execArgv,
          "--report-on-signal",
          "--report-signal=SIGUSR2",
          `--report-directory=${this.reportDir}`,
          "--report-filename=diagnostic.json",
          "--report-exclude-env",
          "--report-exclude-network",
          `--import=${new URL("./vitest.fork-diagnostics.mjs", import.meta.url).href}`,
        ];
      } catch {
        // Missing diagnostic storage must not prevent a worker from starting.
      }
    }
    const children: ChildProcess[] = [];
    const observe = (message: unknown) => {
      if (isRecord(message) && message.process instanceof ChildProcess) {
        children.push(message.process);
      }
    };
    // Vitest 5.0.0 + patches/vitest@5.0.0.patch (pnpm hash 5e7c1655) starts
    // forks synchronously and calls stop() after its deadline or joined exit.
    // Recheck that contract on upgrades; the transport remains Vitest-owned.
    subscribe("child_process", observe);
    let started: Promise<void>;
    try {
      started = super.start();
    } finally {
      unsubscribe("child_process", observe);
    }
    this.child = children.find((child) => child.spawnargs?.includes(this.entrypoint));
    this.child?.once("exit", () => clearTimeout(this.diagnosticTimer));
    await started;
  }

  override send(message: WorkerRequest): void {
    if (message.type === "stop") {
      this.stopRequested = true;
      this.diagnosticTimer ??= setTimeout(() => {
        this.diagnostics ??= this.captureDiagnostics();
      }, 10_000);
      this.diagnosticTimer.unref();
    } else if (message.type === "run" || message.type === "collect") {
      this.files = message.context.files.map(({ filepath }) =>
        path.relative(this.project.config.root, filepath),
      );
    }
    if (message.type === "stop") {
      this.exitEntryReset = false;
      if (this.reportDir) {
        try {
          fs.rmSync(path.join(this.reportDir, "exit-entry.json"), { force: true });
          this.exitEntryReset = true;
        } catch {
          // A stale marker must not become evidence for this stop request.
        }
      }
    }
    super.send(message);
  }

  override waitForExit(): Promise<void> {
    // The public pool hook runs after the transport acknowledges its graceful exit.
    this.stopAcknowledged = true;
    return super.waitForExit();
  }

  private async captureDiagnostics(): Promise<void> {
    try {
      const child = this.child;
      if (this.stopRequested && child?.exitCode === null && child.signalCode === null) {
        const osReport = child.pid
          ? collectVitestForkOsDiagnostics(child.pid)
          : Promise.resolve("OS process diagnostics unavailable.");
        let report = "Node diagnostic report unavailable on this runtime or host.";
        if (this.reportDir && child.kill("SIGUSR2")) {
          report = await collectNodeDiagnosticReport(path.join(this.reportDir, "diagnostic.json"));
        }
        const boundedReport =
          report.length > MAX_REPORT_CHARS
            ? `${report.slice(0, MAX_REPORT_CHARS)}\n[Node diagnostic report truncated]`
            : report;
        this.project.vitest.logger.error(
          `[vitest-pool-diagnostics] pid=${child.pid} project=${JSON.stringify(this.project.name)} stopAcknowledged=${this.stopAcknowledged} files=${JSON.stringify(this.files)}\n${boundedReport}\n[/vitest-pool-diagnostics]`,
        );
        const resources = ["active-resources.json", "synchronous-wait.json", "exit-entry.json"].map(
          (name) => {
            if (name === "exit-entry.json" && !this.exitEntryReset) {
              return `${name}: unavailable (stop reset failed)`;
            }
            try {
              return `${name}: ${fs.readFileSync(path.join(this.reportDir!, name), "utf8").slice(0, 8_192)}`;
            } catch {
              return `${name}: unavailable`;
            }
          },
        );
        this.project.vitest.logger.error(
          `[vitest-pool-resources] pid=${child.pid}\n${resources.join("\n")}\n${await osReport}\n[/vitest-pool-resources]`,
        );
      }
    } catch {
      this.project.vitest.logger.error("[vitest-pool-diagnostics] Node report capture failed.");
    }
  }

  override async stop(): Promise<void> {
    clearTimeout(this.diagnosticTimer);
    try {
      await super.stop();
    } finally {
      await this.diagnostics;
      if (this.reportDir) {
        try {
          fs.rmSync(this.reportDir, { recursive: true, force: true });
        } catch {
          this.project.vitest.logger.error(
            "[vitest-pool-diagnostics] Report directory cleanup failed.",
          );
        }
      }
    }
  }
}

export const diagnosticForksPool = {
  name: POOL_NAME,
  createPoolWorker: (options: PoolOptions) => new DiagnosticForksPoolWorker(options),
};
