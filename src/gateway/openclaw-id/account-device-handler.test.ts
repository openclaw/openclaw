// openclawId.account releases a device sign-in's ID token only to the live personal connection
// and profile that started it: the Gateway holds the device code, and authority is checked
// again after the issuer answers, right before the token leaves the Gateway.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";

const ISSUER = "https://issuer.example.test/api/auth";
const config = {
  gateway: { openclawId: { enabled: true, issuerUrl: ISSUER, clientId: "control-ui" } },
};
// Runs while the Gateway waits for the issuer's token response.
let duringRedemption = () => {};

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}

function personal(profileId: string, connId: string) {
  return {
    connId,
    connect: { role: "operator", scopes: ["operator.read"] },
    internal: { authenticatedOperator: true },
    authenticatedUserProfile: { profileId },
  } as {
    connId: string;
    connect: { role: string; scopes: string[] };
    internal: { authenticatedOperator: true };
    authenticatedUserProfile: { profileId: string };
    invalidated?: boolean;
  };
}

type Client = ReturnType<typeof personal>;
const live = new Set<Client>();
let handlers: typeof import("../server-methods/openclaw-id.js").openclawIdHandlers;

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          device_authorization_endpoint: `${ISSUER}/oauth2/device-authorization`,
        });
      }
      if (url.endsWith("/oauth2/device-authorization")) {
        return Response.json({
          device_code: "dc",
          user_code: "WDJB-MJHT",
          verification_uri: "https://issuer.example.test/device",
          expires_in: 600,
          // A one-millisecond polling interval keeps the test on real time.
          interval: 0.001,
        });
      }
      duringRedemption();
      return Response.json({
        id_token: idToken({
          iss: ISSUER,
          aud: "control-ui",
          sub: "acct-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    }),
  );
  // The sign-in flow captures fetch when the handler module loads.
  ({ openclawIdHandlers: handlers } = await import("../server-methods/openclaw-id.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  duringRedemption = () => {};
  config.gateway.openclawId.enabled = true;
  live.clear();
});

async function call(client: Client, params: Record<string, unknown>) {
  let reply: { ok: boolean; payload?: unknown; code?: string } | undefined;
  await handlers["openclawId.account"]!({
    params,
    client,
    respond: (ok: boolean, payload?: unknown, error?: { details?: { code?: string } }) => {
      reply = { ok, payload, code: error?.details?.code };
    },
    context: {
      getRuntimeConfig: () => config,
      getClientConnIds: (match: (candidate: Client) => boolean) =>
        new Set([...live].filter(match).map((candidate) => candidate.connId)),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

async function begin(client: Client) {
  const started = await call(client, { action: "device_begin" });
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  return (started.payload as { state: string }).state;
}

describe("device sign-in custody", () => {
  it("releases the account to the profile that started it, once", async () => {
    const josh = personal("profile-josh", "c1");
    live.add(josh);
    const state = await begin(josh);
    expect(await call(josh, { action: "device_poll", state })).toMatchObject({
      ok: true,
      payload: { account: { sub: "acct-1" }, idToken: expect.any(String) },
    });
    expect((await call(josh, { action: "device_poll", state })).code).toBe("state_mismatch");
  });

  it("never lets another profile redeem or cancel a pending sign-in", async () => {
    const josh = personal("profile-josh", "c1");
    const other = personal("profile-other", "c2");
    live.add(josh).add(other);
    const state = await begin(josh);
    expect((await call(other, { action: "device_poll", state })).code).toBe("state_mismatch");
    expect(await call(josh, { action: "device_poll", state })).toMatchObject({ ok: true });
  });

  it.each([
    ["the connection closes", (client: Client) => live.delete(client)],
    ["the connection is invalidated", (client: Client) => (client.invalidated = true)],
    [
      "the connection's profile is reassigned",
      (client: Client) => (client.authenticatedUserProfile.profileId = "profile-other"),
    ],
    ["the Labs switch turns off", () => (config.gateway.openclawId.enabled = false)],
  ])("discards the token when %s while the issuer answers", async (_name, change) => {
    const josh = personal("profile-josh", "c1");
    live.add(josh);
    const state = await begin(josh);
    duringRedemption = () => change(josh);
    const reply = await call(josh, { action: "device_poll", state });
    expect(reply).toMatchObject({ ok: false, code: "not_personal_connection" });
    expect(reply.payload).toBeUndefined();
  });
});
