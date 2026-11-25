import type { Locator } from "playwright";

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
