import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const commandSuccess = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  termination: "exit" as const,
};

// Minimal independent projection of Gog's schema v1 command metadata.
export function gogServeSchema(envFlags = ["token-env", "hook-token-env"]) {
  return {
    schema_version: 1,
    command: {
      type: "command",
      name: "serve",
      flags: ["token", "hook-token", ...envFlags].map((name) => ({ name, type: "string" })),
    },
  };
}
export const gogSchemaSuccess = { ...commandSuccess, stdout: JSON.stringify(gogServeSchema()) };

export function commandGate(abortCode?: number | null) {
  const result = createDeferred<{ code: number | null; stdout: string; stderr: string }>();
  let signal: AbortSignal | undefined;
  return {
    ...result,
    get signal() {
      return signal;
    },
    run: (options: { signal?: AbortSignal }) => {
      signal = options.signal;
      if (abortCode !== undefined) {
        const aborted = { code: abortCode, stdout: "", stderr: abortCode === 0 ? "" : "aborted" };
        signal?.addEventListener("abort", () => result.resolve(aborted), { once: true });
      }
      return result.promise;
    },
  };
}

export function createGmailConfig(
  account = "me@example.com",
  renewEveryMinutes?: number,
  tailscale?: { mode: "off" | "serve" },
): OpenClawConfig {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account,
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
        renewEveryMinutes,
        tailscale,
      },
    },
  };
}

export class WatcherChild extends EventEmitter {
  alive = true;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((signal = "SIGTERM") => {
    queueMicrotask(() => this.exit(null, signal));
    return true;
  });
  constructor(readonly pid?: number) {
    super();
  }
  exit(code: number | null = 1, signal: string | null = null) {
    this.alive = false;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
