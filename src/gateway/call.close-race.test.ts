import type { OpenClawConfig } from "../config/config.js";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockGatewayClientOptions = {
  onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
  onClose?: (code: number, reason: string) => void;
};

describe("callGateway close handling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./client.js");
    vi.doUnmock("../infra/device-identity.js");
  });

  it("preserves cron.list results when normal close lands during request settle", async () => {
    let lastClientOptions: MockGatewayClientOptions | null = null;

    vi.resetModules();

    vi.doMock("../infra/device-identity.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/device-identity.js")>();
      return {
        ...actual,
        loadOrCreateDeviceIdentity: () => ({
          deviceId: "test-device",
          privateKeyPem: "test-private-key",
          publicKeyPem: "test-public-key",
        }),
      };
    });

    vi.doMock("./client.js", () => ({
      describeGatewayCloseCode: (code: number) => {
        if (code === 1000) {
          return "normal closure";
        }
        if (code === 1006) {
          return "abnormal closure (no close frame)";
        }
        return undefined;
      },
      GatewayClient: class {
        constructor(opts: MockGatewayClientOptions) {
          lastClientOptions = opts;
        }

        start() {
          void lastClientOptions?.onHelloOk?.({
            features: {
              methods: ["cron.list"],
            },
          });
        }

        async request() {
          return await Promise.resolve().then(() => {
            lastClientOptions?.onClose?.(1000, "");
            return {
              jobs: [],
              total: 0,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            };
          });
        }

        stop() {}
      },
    }));

    const { callGateway } = await import("./call.js");

    await expect(
      callGateway({
        config: {
          gateway: { mode: "local", bind: "loopback" },
        } as OpenClawConfig,
        configPath: "/tmp/openclaw-call-close-race.json",
        method: "cron.list",
        params: { includeDisabled: true },
      }),
    ).resolves.toEqual({
      jobs: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    });
  });
});
