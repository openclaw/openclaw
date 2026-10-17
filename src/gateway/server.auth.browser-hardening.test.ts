import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import {
  CONTROL_UI_CLIENT,
  TEST_OPERATOR_CLIENT,
  createSignedDevice,
  openWs,
  originForPort,
} from "./server.auth.test-helpers.js";
import {
  connectReq,
  connectOk,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const makeIdentityPath = useAuthIdentityFixture();

const ALLOWED_BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_BROWSER_HEADERS = {
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.com",
};

type GatewayConnectResponse = Awaited<ReturnType<typeof connectReq>>;
type GatewayTestClient = NonNullable<NonNullable<Parameters<typeof connectReq>[1]>["client"]>;
type SignedBrowserDevice = Awaited<ReturnType<typeof createSignedDevice>>;
type OriginCase = {
  name: string;
  proxy: boolean;
  client: GatewayTestClient;
  headers: Record<string, string>;
};

async function withTrustedProxyBrowserWs(
  origin: string,
  run: (ws: WebSocket) => Promise<void>,
  password?: string,
) {
  const { writeConfigFile } = await import("../config/config.js");
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
    ...(password ? { password } : {}),
  };
  // The harness otherwise replaces file auth with its default token policy.
  testState.gatewayAuth = auth;
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      publicOrigin: ALLOWED_BROWSER_ORIGIN,
    },
  });
  await withBrowserWs(run, () => ({ origin, ...TRUSTED_PROXY_BROWSER_HEADERS }));
}

async function withBrowserWs(
  run: (ws: WebSocket) => Promise<void>,
  headers: (port: number) => Record<string, string> = (port) => ({ origin: originForPort(port) }),
) {
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port, headers(port));
    try {
      await run(ws);
    } finally {
      ws.close();
    }
  });
}

function expectOriginNotAllowed(res: GatewayConnectResponse) {
  expect(res).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("origin not allowed"),
      details: { code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED },
    },
  });
}

async function expectWrongTokenRejected(params: {
  port: number;
  headers?: Record<string, string>;
  retryLater: boolean;
  device?: null;
}) {
  const ws = await openWs(params.port, params.headers);
  try {
    const request = params.device === null ? { token: "wrong", device: null } : { token: "wrong" };
    const res = await connectReq(ws, request);
    expect(res.ok).toBe(false);
    expect((res.error?.message ?? "").includes("retry later")).toBe(params.retryLater);
  } finally {
    ws.close();
  }
}

async function withSignedBrowserConnect(
  client: GatewayTestClient,
  identityName: string,
  run: (session: {
    identity: SignedBrowserDevice["identity"];
    res: GatewayConnectResponse;
  }) => void | Promise<void>,
) {
  await withBrowserWs(async (browserWs) => {
    const nonce = await readConnectChallengeNonce(browserWs);
    expect(typeof nonce).toBe("string");
    const { identity, device } = await createSignedDevice({
      token: "secret",
      scopes: ["operator.admin"],
      clientId: client.id,
      clientMode: client.mode,
      identityPath: makeIdentityPath(`openclaw-${identityName}-device-${randomUUID()}.sqlite`),
      nonce: nonce ?? "",
    });
    const res = await connectReq(browserWs, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device,
    });
    await run({ identity, res });
  });
}

beforeEach(() => {
  testState.gatewayAuth = { mode: "token", token: "secret" };
});

test.each<OriginCase>([
  {
    name: "trusted-proxy browser",
    proxy: true,
    client: TEST_OPERATOR_CLIENT,
    headers: { origin: "https://evil.example", ...TRUSTED_PROXY_BROWSER_HEADERS },
  },
  {
    name: "browser claiming to be TUI",
    proxy: false,
    client: {
      ...TEST_OPERATOR_CLIENT,
      id: GATEWAY_CLIENT_NAMES.TUI,
      platform: "macos",
      mode: GATEWAY_CLIENT_MODES.UI,
    },
    headers: { origin: "https://attacker.example" },
  },
  {
    name: "forwarded control-ui forging loopback",
    proxy: false,
    client: {
      ...TEST_OPERATOR_CLIENT,
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.UI,
    },
    headers: { origin: "http://localhost:5173", "x-forwarded-for": "203.0.113.50" },
  },
])("rejects non-allowlisted origin for $name", async ({ proxy, client, headers }) => {
  const reject = async (ws: WebSocket) => {
    expectOriginNotAllowed(await connectReq(ws, { client, device: null }));
  };
  if (proxy) {
    await withTrustedProxyBrowserWs(headers.origin, reject);
  } else {
    const { writeConfigFile } = await import("../config/config.js");
    if ("x-forwarded-for" in headers) {
      await writeConfigFile({
        gateway: { trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [] } },
      });
    }
    await withBrowserWs(reject, () => headers);
  }
});

test("accepts trusted-proxy publicOrigin despite an unused redacted password", async () => {
  await withTrustedProxyBrowserWs(
    ALLOWED_BROWSER_ORIGIN,
    async (ws) => {
      await connectOk(ws, {
        client: TEST_OPERATOR_CLIENT,
        device: null,
        skipDefaultAuth: true,
      });
    },
    REDACTED_SENTINEL,
  );
});

test("clears scopes for trusted-proxy non-control-ui browser sessions", async () => {
  await withTrustedProxyBrowserWs(ALLOWED_BROWSER_ORIGIN, async (ws) => {
    await connectOk(ws, {
      client: TEST_OPERATOR_CLIENT,
      device: null,
      scopes: ["operator.read"],
    });

    expect(await rpcReq(ws, "status")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("missing scope") },
    });
  });
});

test("accepts an exactly allowlisted Tauri origin", async () => {
  const { writeConfigFile } = await import("../config/config.js");
  const origin = "tauri://localhost";
  await writeConfigFile({ gateway: { controlUi: { allowedOrigins: [origin] } } });
  await withBrowserWs(
    async (ws) => {
      await connectOk(ws, {
        client: TEST_OPERATOR_CLIENT,
        device: null,
      });
    },
    () => ({ origin }),
  );
});

test("rate-limits non-browser remote auth failures by default", async () => {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({ gateway: { trustedProxies: ["127.0.0.1"] } });

  await withGatewayServer(async ({ port }) => {
    const request = { port, headers: { "x-forwarded-for": "203.0.113.50" }, device: null };
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await expectWrongTokenRejected({ ...request, retryLater: false });
    }
    await expectWrongTokenRejected({ ...request, retryLater: true });
  });
});

test("isolates loopback browser-origin auth lockouts per origin", async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: true },
  };
  await withGatewayServer(async ({ port }) => {
    const firstOrigin = originForPort(port);
    const secondOrigin = "http://localhost:5173";

    await expectWrongTokenRejected({ port, headers: { origin: firstOrigin }, retryLater: false });
    await expectWrongTokenRejected({
      port,
      headers: { origin: secondOrigin },
      retryLater: false,
    });
    await expectWrongTokenRejected({ port, headers: { origin: firstOrigin }, retryLater: true });
  });
});

test("omits sensitive gateway paths from low-privilege hello-ok snapshots", async () => {
  await withBrowserWs(async (ws) => {
    const payload = await connectOk(ws, {
      scopes: ["operator.read"],
      device: null,
    });
    // Assert effective scopes after unbound-scope clearing, not self-declared scopes.
    const { snapshot } = payload as {
      type: "hello-ok";
      snapshot: { configPath?: unknown; stateDir?: unknown; authMode?: unknown };
    };
    expect(snapshot).toBeDefined();
    for (const field of ["configPath", "stateDir", "authMode"] as const) {
      expect(snapshot[field]).toBeUndefined();
    }
  });
});

test.each([
  { name: "non-control-ui", client: TEST_OPERATOR_CLIENT, paired: false },
  { name: "control-ui", client: CONTROL_UI_CLIENT, paired: true },
])(
  "restricts loopback token auto-pairing for $name browser clients",
  async ({ name, client, paired }) => {
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    await withSignedBrowserConnect(client, name, async ({ identity, res }) => {
      expect(res.ok).toBe(paired);
      const pairing = await listDevicePairing();
      const pending = pairing.pending.find((entry) => entry.deviceId === identity.deviceId);
      if (paired) {
        expect(pending).toBeUndefined();
        expect(pairing.paired.some((entry) => entry.deviceId === identity.deviceId)).toBe(true);
      } else {
        expect(res.error?.message ?? "").toContain("pairing required");
        expect(pending).toMatchObject({ silent: false });
      }
    });
  },
);
