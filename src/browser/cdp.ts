import WebSocket from "ws";

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export async function captureScreenshotPng(opts: {
  wsUrl: string;
  fullPage?: boolean;
}): Promise<Buffer> {
  const ws = new WebSocket(opts.wsUrl, { handshakeTimeout: 5000 });

  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send = (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    const msg = { id, method, params };
    ws.send(JSON.stringify(msg));
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(String(data)) as CdpResponse;
      if (typeof parsed.id !== "number") return;
      const p = pending.get(parsed.id);
      if (!p) return;
      pending.delete(parsed.id);
      if (parsed.error?.message) {
        p.reject(new Error(parsed.error.message));
        return;
      }
      p.resolve(parsed.result);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    closeWithError(new Error("CDP socket closed"));
  });

  await openPromise;

  await send("Page.enable");

  let clip:
    | { x: number; y: number; width: number; height: number; scale: number }
    | undefined;
  if (opts.fullPage) {
    const metrics = (await send("Page.getLayoutMetrics")) as {
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    };
    const size = metrics?.cssContentSize ?? metrics?.contentSize;
    const width = Number(size?.width ?? 0);
    const height = Number(size?.height ?? 0);
    if (width > 0 && height > 0) {
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }
  }

  const result = (await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    ...(clip ? { clip } : {}),
  })) as { data?: string };

  const base64 = result?.data;
  if (!base64) {
    closeWithError(new Error("Screenshot failed: missing data"));
    throw new Error("Screenshot failed: missing data");
  }

  try {
    ws.close();
  } catch {
    // ignore
  }

  return Buffer.from(base64, "base64");
}
