import { posix, win32 } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WorkerDesktopApp,
  WorkerDesktopEndpoint,
} from "../../plugins/capability-provider.types.js";

const MAX_WORKER_DESKTOP_APPS = 8;

export function normalizeWorkerDesktopEndpoint(
  value: WorkerDesktopEndpoint,
): WorkerDesktopEndpoint {
  if (!isRecord(value) || value.protocol !== "rfb") {
    throw new Error('Worker environment desktop protocol must be "rfb"');
  }
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("Worker environment desktop port must be an integer from 1 through 65535");
  }
  const passwordFilePath = value.passwordFilePath;
  if (
    passwordFilePath !== undefined &&
    (typeof passwordFilePath !== "string" ||
      !(posix.isAbsolute(passwordFilePath) || win32.isAbsolute(passwordFilePath)))
  ) {
    throw new Error("Worker environment desktop password file path must be absolute");
  }
  if (value.allowsResize !== undefined && typeof value.allowsResize !== "boolean") {
    throw new Error("Worker environment desktop allowsResize must be a boolean");
  }
  const username = value.username;
  if (
    username !== undefined &&
    (typeof username !== "string" ||
      !username.trim() ||
      username.includes("\0") ||
      Buffer.byteLength(username, "utf8") > 63 ||
      !passwordFilePath)
  ) {
    throw new Error(
      "Worker environment desktop username requires a bounded account name and password file",
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
    if (
      typeof app.executablePath !== "string" ||
      !(posix.isAbsolute(app.executablePath) || win32.isAbsolute(app.executablePath))
    ) {
      throw new Error("Worker environment desktop app executable path must be absolute");
    }
    if (app.id === "terminal") {
      if (Object.keys(app).some((key) => key !== "id" && key !== "executablePath")) {
        throw new Error("Worker environment terminal desktop app contains unknown fields");
      }
      return { id: "terminal", executablePath: app.executablePath };
    }
    if (
      Object.keys(app).some((key) => key !== "id" && key !== "executablePath" && key !== "cdpPort")
    ) {
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
    return {
      id: "browser",
      executablePath: app.executablePath,
      cdpPort: app.cdpPort,
    };
  });
  return {
    protocol: "rfb",
    port: value.port,
    ...(passwordFilePath === undefined ? {} : { passwordFilePath }),
    ...(value.allowsResize === undefined ? {} : { allowsResize: value.allowsResize }),
    ...(username === undefined ? {} : { username }),
    ...(value.apps === undefined ? {} : { apps }),
  };
}
