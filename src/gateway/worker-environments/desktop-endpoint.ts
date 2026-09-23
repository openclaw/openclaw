import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WorkerDesktopApp,
  WorkerDesktopEndpoint,
} from "../../plugins/capability-provider.types.js";
import {
  isWorkerDesktopArgs,
  isWorkerDesktopString,
  isWorkerDesktopUsername,
} from "../../shared/worker-desktop-descriptor.js";
import { hasExactOwnKeys } from "../../worker/protocol-record.js";

const MAX_WORKER_DESKTOP_APPS = 8;

function isAbsoluteDesktopPath(value: unknown): value is string {
  return (
    isWorkerDesktopString(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
  );
}

export function normalizeWorkerDesktopEndpoint(value: unknown): WorkerDesktopEndpoint {
  if (!isRecord(value) || value.protocol !== "rfb") {
    throw new Error('Worker environment desktop protocol must be "rfb"');
  }
  if (
    !hasExactOwnKeys(
      value,
      ["protocol", "port"],
      ["passwordFilePath", "username", "apps", "allowsResize"],
    )
  ) {
    throw new Error("Worker environment desktop endpoint contains unknown fields");
  }
  if (
    typeof value.port !== "number" ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new Error("Worker environment desktop port must be an integer from 1 through 65535");
  }
  const passwordFilePath = value.passwordFilePath;
  if (passwordFilePath !== undefined && !isAbsoluteDesktopPath(passwordFilePath)) {
    throw new Error("Worker environment desktop password file path must be absolute");
  }
  if (value.allowsResize !== undefined && typeof value.allowsResize !== "boolean") {
    throw new Error("Worker environment desktop allowsResize must be a boolean");
  }
  if (
    value.username !== undefined &&
    (!isWorkerDesktopUsername(value.username) || !passwordFilePath)
  ) {
    throw new Error(
      "Worker environment desktop username requires a bounded ARD account and password file",
    );
  }
  if (value.apps !== undefined && !Array.isArray(value.apps)) {
    throw new Error("Worker environment desktop apps must be an array");
  }
  if ((value.apps?.length ?? 0) > MAX_WORKER_DESKTOP_APPS) {
    throw new Error(`Worker environment desktop apps cannot exceed ${MAX_WORKER_DESKTOP_APPS}`);
  }
  const seenAppIds = new Set<WorkerDesktopApp["id"]>();
  const apps = (value.apps ?? []).map((app): WorkerDesktopApp => {
    if (!isRecord(app) || (app.id !== "browser" && app.id !== "terminal")) {
      throw new Error('Worker environment desktop app id must be "browser" or "terminal"');
    }
    if (seenAppIds.has(app.id)) {
      throw new Error(`Worker environment desktop app id ${app.id} must be unique`);
    }
    seenAppIds.add(app.id);
    if (!isAbsoluteDesktopPath(app.executablePath)) {
      throw new Error("Worker environment desktop app executable path must be absolute");
    }
    if (app.args !== undefined && !isWorkerDesktopArgs(app.args)) {
      throw new Error("Worker environment desktop app args must be bounded strings");
    }
    let normalized: WorkerDesktopApp;
    if (app.id === "terminal") {
      if (!hasExactOwnKeys(app, ["id", "executablePath"], ["args"])) {
        throw new Error("Worker environment terminal desktop app contains unknown fields");
      }
      normalized = { id: "terminal", executablePath: app.executablePath };
    } else {
      if (!hasExactOwnKeys(app, ["id", "executablePath", "cdpPort"], ["args"])) {
        throw new Error("Worker environment browser desktop app contains unknown fields");
      }
      if (
        typeof app.cdpPort !== "number" ||
        !Number.isSafeInteger(app.cdpPort) ||
        app.cdpPort < 1 ||
        app.cdpPort > 65_535
      ) {
        throw new Error(
          "Worker environment browser CDP port must be an integer from 1 through 65535",
        );
      }
      normalized = {
        id: "browser",
        executablePath: app.executablePath,
        cdpPort: app.cdpPort,
      };
    }
    if (app.args !== undefined) {
      normalized.args = [...app.args];
    }
    return normalized;
  });
  return {
    protocol: "rfb",
    port: value.port,
    ...(passwordFilePath === undefined ? {} : { passwordFilePath }),
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.allowsResize === undefined ? {} : { allowsResize: value.allowsResize }),
    ...(value.apps === undefined ? {} : { apps }),
  };
}
