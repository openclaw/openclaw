import type { Locator } from "playwright";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";

export function sessionList(row: GatewaySessionRow, model = "gpt-5.5"): SessionsListResult {
  return {
    ts: Date.now(),
    path: "",
    count: 1,
    defaults: { modelProvider: "openai", model, contextTokens: null },
    sessions: [row],
  };
}

export function workerDesktop(id: string) {
  return {
    id,
    type: "worker",
    status: "available",
    desktop: true,
    worker: {
      providerId: "crabbox",
      state: "attached",
      ageMs: 1_000,
      attachedSessionIds: [],
      tunnelStatus: "connected",
      desktopApps: [],
    },
  };
}

export function desktopObservation(wsPath: string, control = false) {
  return { transport: "rfb", wsPath, expiresAtMs: 60_000, control };
}

export function canvasPixel(canvas: Locator, offset = 0) {
  return canvas.evaluate((element: HTMLCanvasElement, coordinate) => {
    const pixel = element.getContext("2d")?.getImageData(coordinate, coordinate, 1, 1).data;
    return pixel ? [...pixel] : null;
  }, offset);
}
