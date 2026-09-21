import type { GatewayBrowserClient } from "../api/gateway.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
type CanvasSurfaceLeaseModule = typeof import("./canvas-surface-lease.runtime.ts");
type CanvasSurfaceLease = ReturnType<CanvasSurfaceLeaseModule["createCanvasSurfaceLease"]>;

export function createGatewayCanvasSurfaceLease(
  currentClient: () => GatewayBrowserClient | null,
  onChange: (url: string | null) => void,
) {
  let canvasSurfaceLease: CanvasSurfaceLease | null = null;
  let canvasSurfaceLeaseLoad: Promise<CanvasSurfaceLease> | null = null;
  let canvasSurfaceLeaseClient: GatewayBrowserClient | null = null;
  let canvasSurfaceLeaseGeneration = 0;
  const loadCanvasSurfaceLease = (): Promise<CanvasSurfaceLease> => {
    if (canvasSurfaceLease) {
      return Promise.resolve(canvasSurfaceLease);
    }
    if (canvasSurfaceLeaseLoad) {
      return canvasSurfaceLeaseLoad;
    }
    const load = import("./canvas-surface-lease.runtime.ts").then(
      ({ createCanvasSurfaceLease }) => {
        const lease = createCanvasSurfaceLease({
          request: (method, params) => {
            const requestClient = canvasSurfaceLeaseClient;
            if (!requestClient || currentClient() !== requestClient) {
              return Promise.reject(
                new Error("canvas surface lease has no current gateway client"),
              );
            }
            return requestClient.request(method, params);
          },
          onChange: (canvasPluginSurfaceUrl) => {
            if (!canvasSurfaceLeaseClient || currentClient() !== canvasSurfaceLeaseClient) {
              return;
            }
            onChange(canvasPluginSurfaceUrl);
          },
        });
        canvasSurfaceLease = lease;
        return lease;
      },
    );
    canvasSurfaceLeaseLoad = load;
    void load.catch(() => {
      if (canvasSurfaceLeaseLoad === load) {
        canvasSurfaceLeaseLoad = null;
      }
    });
    return load;
  };
  const beginCanvasSurfaceLease = (nextClient: GatewayBrowserClient): number => {
    canvasSurfaceLeaseClient = null;
    canvasSurfaceLease?.stop();
    canvasSurfaceLeaseGeneration += 1;
    canvasSurfaceLeaseClient = nextClient;
    // Rotation keeps mounted frames; a new hello starts a connection and must
    // re-key them before the synchronously published URL can render.
    bumpCanvasWidgetFrameConnectionGeneration();
    return canvasSurfaceLeaseGeneration;
  };
  const startCanvasSurfaceLease = (
    nextClient: GatewayBrowserClient,
    expectedGeneration: number,
    helloUrl: string | undefined,
  ): void => {
    void loadCanvasSurfaceLease()
      .then((lease) => {
        if (
          canvasSurfaceLeaseGeneration === expectedGeneration &&
          canvasSurfaceLeaseClient === nextClient &&
          currentClient() === nextClient
        ) {
          lease.start(helloUrl);
        }
      })
      .catch(() => {
        // main.ts owns lazy-chunk fetch recovery through the Vite preload-error
        // listener; retrying the same module URL cannot escape its cached failure.
      });
  };
  const stopCanvasSurfaceLease = () => {
    if (!canvasSurfaceLeaseClient) {
      return;
    }
    canvasSurfaceLeaseGeneration += 1;
    canvasSurfaceLeaseClient = null;
    canvasSurfaceLease?.stop();
    // Disconnect invalidates every capability URL, including those held by a
    // frame that remounts after the socket closes.
    bumpCanvasWidgetFrameConnectionGeneration();
  };
  return {
    begin: beginCanvasSurfaceLease,
    start: startCanvasSurfaceLease,
    stop: stopCanvasSurfaceLease,
    get generation() {
      return canvasSurfaceLeaseGeneration;
    },
  };
}
