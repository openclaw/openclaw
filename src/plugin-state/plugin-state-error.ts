import { threadId } from "node:worker_threads";
import { VERSION } from "../version.js";
import { capturePluginStateErrorCause } from "./plugin-state-error-cause.js";

export type PluginStateStoreErrorCode =
  | "PLUGIN_STATE_SQLITE_UNAVAILABLE"
  | "PLUGIN_STATE_OPEN_FAILED"
  | "PLUGIN_STATE_WRITE_FAILED"
  | "PLUGIN_STATE_READ_FAILED"
  | "PLUGIN_STATE_CORRUPT"
  | "PLUGIN_STATE_LIMIT_EXCEEDED"
  | "PLUGIN_STATE_INVALID_INPUT";

export type PluginStateStoreOperation =
  | "load-sqlite"
  | "open"
  | "ensure-schema"
  | "register"
  | "lookup"
  | "consume"
  | "delete"
  | "entries"
  | "count"
  | "clear"
  | "sweep"
  | "probe"
  | "close";

type PluginStateStoreErrorOptions = {
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  path?: string;
  cause?: unknown;
  owner?: { pid: number; threadId: number; version: string };
};

/** Typed error thrown for plugin-state validation and sqlite failures. */
export class PluginStateStoreError extends Error {
  readonly code: PluginStateStoreErrorCode;
  readonly operation: PluginStateStoreOperation;
  readonly path?: string;
  readonly owner: { pid: number; threadId: number; version: string };

  constructor(message: string, options: PluginStateStoreErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "PluginStateStoreError";
    this.code = options.code;
    this.operation = options.operation;
    this.owner = options.owner ?? { pid: process.pid, threadId, version: VERSION };
    if (options.path) {
      this.path = options.path;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      operation: this.operation,
      path: this.path,
      owner: this.owner,
      cause: capturePluginStateErrorCause(this.cause),
    };
  }
}
