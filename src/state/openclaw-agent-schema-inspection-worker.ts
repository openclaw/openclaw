import { fork } from "node:child_process";
import fs from "node:fs";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  resolveSqliteInspectionBudget,
  sqliteInspectionTimeoutError,
} from "../infra/sqlite-readonly-worker.js";
import type {
  AgentSchemaInspection,
  AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";

/** Join the reader before releasing caller authority, including on cancellation. */
export function inspectAgentDatabaseSchemaInWorker(
  input: AgentSchemaInspectionInput,
  signal?: AbortSignal,
): Promise<AgentSchemaInspection | null> {
  signal?.throwIfAborted();
  const { timeoutMs, size } = resolveSqliteInspectionBudget(
    "schema inspection",
    input.pathname,
    fs.statSync(input.pathname).size,
  );
  const entry = resolveRuntimeProcessEntrypointUrl("agentSchemaInspection");
  const child = fork(entry, [], {
    execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    signal,
  });
  return new Promise((resolve, reject) => {
    let result: AgentSchemaInspection | null | undefined;
    let failure: Error | undefined;
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("ok" in message)) {
        failure = new Error("Invalid agent schema inspection response");
      } else if (
        message.ok === false &&
        "message" in message &&
        typeof message.message === "string"
      ) {
        failure = new Error(message.message);
      } else if (message.ok === true && "inspection" in message) {
        const value = message.inspection;
        if (value === null) {
          result = null;
        } else if (
          typeof value === "object" &&
          "version" in value &&
          typeof value.version === "number" &&
          Number.isSafeInteger(value.version) &&
          (!("writerAppVersion" in value) || typeof value.writerAppVersion === "string") &&
          (!("reason" in value) || typeof value.reason === "string")
        ) {
          result = {
            version: value.version,
            ...("writerAppVersion" in value && typeof value.writerAppVersion === "string"
              ? { writerAppVersion: value.writerAppVersion }
              : {}),
            ...("reason" in value && typeof value.reason === "string"
              ? { reason: value.reason }
              : {}),
          };
        } else {
          failure = new Error("Invalid agent schema inspection response");
        }
      } else {
        failure = new Error("Invalid agent schema inspection response");
      }
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, exitSignal) => {
      if (signal?.aborted) {
        reject(toStringifiedError(signal.reason));
      } else if (failure) {
        reject(failure);
      } else if (code !== 0 || result === undefined) {
        reject(
          exitSignal === "SIGKILL"
            ? sqliteInspectionTimeoutError("schema inspection", input.pathname, timeoutMs, size)
            : new Error(`Agent schema inspection exited ${code} without a completed result`),
        );
      } else {
        resolve(result);
      }
    });
    child.send(input, (error) => {
      if (error) {
        failure ??= error;
        child.kill("SIGKILL");
      }
    });
  });
}
