import { createServer, type AddressInfo } from "node:net";
import { fetch as realFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testPort = 0;
let prevGatewayPort: string | undefined;

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      gateway: {
        auth: {
          token: "browser-control-secret",
        },
      },
      browser: {
        enabled: true,
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: testPort + 1, color: "#FF4500" },
        },
      },
    }),
  };
});

vi.mock("./routes/index.js", () => ({
  registerBrowserRoutes(app: {
    get: (
      path: string,
      handler: (req: unknown, res: { json: (body: unknown) => void }) => void,
    ) => void;
  }) {
    app.get("/", (_req, res) => {
      res.json({ ok: true });
    });
  },
}));

vi.mock("./server-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-context.js")>();
  return {
    ...actual,
    createBrowserRouteContext: vi.fn(() => ({
      forProfile: vi.fn(() => ({
        stopRunningBrowser: vi.fn(async () => {}),
      })),
    })),
  };
});

describe("browser control HTTP auth", () => {
  beforeEach(async () => {
    prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = probe.address() as AddressInfo;
    testPort = addr.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    process.env.OPENCLAW_GATEWAY_PORT = String(testPort - 2);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (prevGatewayPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
    }

    const { stopBrowserControlServer } = await import("./server.js");
    await stopBrowserControlServer();
  });

  it("requires bearer auth for standalone browser HTTP routes", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    const started = await startBrowserControlServerFromConfig();
    expect(started?.port).toBe(testPort);

    const base = `http://127.0.0.1:${testPort}`;

    const missingAuth = await realFetch(`${base}/`);
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.text()).toContain("Unauthorized");

    const badAuth = await realFetch(`${base}/`, {
      headers: {
        Authorization: "Bearer wrong-token",
      },
    });
    expect(badAuth.status).toBe(401);

    const ok = await realFetch(`${base}/`, {
      headers: {
        Authorization: "Bearer browser-control-secret",
      },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { ok: boolean }).toEqual({ ok: true });
  });
});
