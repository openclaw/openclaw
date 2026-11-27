// A device-code approval (RFC 8628) does not show who approved it, so a device sign-in only
// recognizes an existing OpenClaw ID link and never creates a profile's first one. Real profile state.
import { afterAll, beforeAll, expect, vi } from "vitest";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import {
  linkCanonicalOpenClawIdUserProfile,
  readOpenClawIdLinkedProfile,
  readOpenClawIdLinksOfProfile,
} from "../../state/user-profile-openclaw-id.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";

const ISSUER = "https://issuer.example.test/api/auth";
const PROFILE_EMAIL = "person@example.test";

// The personal-profile authority owner has its own tests; here it admits the caller's profile.
vi.mock("../server-methods/personal-profile-authorization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-methods/personal-profile-authorization.js")>()),
  preparePersonalProfileAction: vi.fn(
    async (opts: { client: { authenticatedUserProfile: { profileId: string } } }) => ({
      owner: opts.client.authenticatedUserProfile.profileId,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    }),
  ),
}));

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}

// The account that approved the user code; by default a second account with the profile's email.
let approver = "ocid-other";
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
          interval: 0.001,
        });
      }
      return Response.json({
        id_token: idToken({
          iss: ISSUER,
          aud: "control-ui",
          sub: approver,
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: PROFILE_EMAIL,
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

const config = {
  gateway: { openclawId: { enabled: true, issuerUrl: ISSUER, clientId: "control-ui" } },
};

async function call(client: { connId: string }, params: Record<string, unknown>) {
  let reply: { ok: boolean; payload?: unknown; code?: string } | undefined;
  await handlers["openclawId.account"]!({
    params,
    client,
    respond: (ok: boolean, payload?: unknown, error?: { details?: { code?: string } }) => {
      reply = { ok, payload, code: error?.details?.code };
    },
    context: {
      getRuntimeConfig: () => config,
      getClientConnIds: (match: (candidate: unknown) => boolean) =>
        new Set([client].filter(match).map((current) => current.connId)),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return reply!;
}

async function deviceSignIn(client: { connId: string }, link: boolean) {
  const started = await call(client, { action: "device_begin" });
  const state = (started.payload as { state: string }).state;
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  return await call(client, { action: "device_poll", state, link });
}

const it = stateTest("openclaw-id-account-link-persistence");

it("a device grant from another account never creates a profile's first link", async ({
  state,
}) => {
  state.applyEnv();
  approver = "ocid-other";
  const existingProfile = await ensureCanonicalUserProfileForEmail(PROFILE_EMAIL);
  const connection = {
    connId: "conn-person",
    connect: { role: "operator", scopes: ["operator.read"] },
    internal: { authenticatedOperator: true },
    authenticatedUserProfile: { profileId: existingProfile.id },
  };

  const polled = await deviceSignIn(connection, true);
  expect(polled).toMatchObject({
    ok: true,
    payload: { account: { sub: "ocid-other" }, link: "link_approval_required" },
  });
  const { idToken: held } = polled.payload as { idToken: string };
  expect(await call(connection, { action: "link_held", idToken: held })).toMatchObject({
    ok: true,
    payload: { link: "link_approval_required" },
  });
  expect(await readOpenClawIdLinkedProfile("ocid-other")).toBeNull();
  expect(await readOpenClawIdLinksOfProfile(existingProfile.id)).toEqual([]);

  // A binding approved elsewhere (here written directly) is still recognized after sign-in.
  approver = "ocid-person";
  expect(
    await linkCanonicalOpenClawIdUserProfile({
      profileId: existingProfile.id,
      accountId: "ocid-person",
      email: PROFILE_EMAIL,
    }),
  ).toEqual({ ok: true });
  expect(await deviceSignIn(connection, true)).toMatchObject({
    ok: true,
    payload: { account: { sub: "ocid-person" }, link: "linked" },
  });
  // Another account on the now-linked profile is told to unlink first, and is not added.
  approver = "ocid-other";
  expect(await deviceSignIn(connection, true)).toMatchObject({
    ok: true,
    payload: { account: { sub: "ocid-other" }, link: "profile_linked" },
  });
  expect(await readOpenClawIdLinkedProfile("ocid-other")).toBeNull();
  expect(await readOpenClawIdLinksOfProfile(existingProfile.id)).toEqual([
    { accountId: "ocid-person", email: PROFILE_EMAIL },
  ]);
});
