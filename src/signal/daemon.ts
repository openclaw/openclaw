import { spawn } from "node:child_process";
import type { RuntimeEnv } from "../runtime.js";

export type SignalDaemonOpts = {
  cliPath: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  runtime?: RuntimeEnv;
};

export type SignalDaemonHandle = {
  pid?: number;
  stop: () => void;
};

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  args.push("--http", `${opts.httpHost}:${opts.httpPort}`);
  args.push("--no-receive-stdout");

  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) args.push("--ignore-attachments");
  if (opts.ignoreStories) args.push("--ignore-stories");
  if (opts.sendReadReceipts) args.push("--send-read-receipts");

  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  const args = buildDaemonArgs(opts);
  const child = spawn(opts.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});

  child.stdout?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) log(`signal-cli: ${text}`);
  });
  child.stderr?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) error(`signal-cli: ${text}`);
  });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
  });

  return {
    pid: child.pid ?? undefined,
    stop: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}
