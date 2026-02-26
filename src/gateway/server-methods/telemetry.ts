import { getTelemetrySnapshot } from "../../logging/diagnostic.js";
import type { GatewayRequestHandlers } from "./types.js";

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const telemetryHandlers: GatewayRequestHandlers = {
  "telemetry.get": async ({ respond }) => {
    try {
      const snapshot = getTelemetrySnapshot();
      respond(true, snapshot);
    } catch (err: unknown) {
      respond(false, undefined, { name: "TelemetryError", message: toErrorMessage(err) });
    }
  },
};
