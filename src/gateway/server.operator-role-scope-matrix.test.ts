import { randomUUID, X509Certificate } from "node:crypto";
import http, { createServer, IncomingMessage } from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { getRuntimeConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkCanonicalOpenClawIdUserProfile } from "../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import { checkAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { startGatewayServerCore } from "./server-start.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import { listCurrentWebPushTargets } from "./web-push-authority.js";

// Nonmember expectations are pinned to 3a93a8d232859796d5ad4146258d392512091561,
// not computed by a policy helper in the implementation under test. Member rows
// assert the corrected profile-scoped contract, including alternate ingress.
const ALL: OperatorScope[] = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.talk",
];
const RW: OperatorScope[] = ["operator.read", "operator.write"];
const PRESET = ALL.slice(1);
const COLUMNS = ["absent", "catalog", "default", "assignment"] as const;
const ROWS = ["local", "token", "proxy", "cloudflare", "member", "member-proxy"] as const;
type Column = (typeof COLUMNS)[number];
type Row = (typeof ROWS)[number];
type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
const definitions: NonNullable<GatewayOperatorRolesConfig>["definitions"] = {
  operator: { agents: "*", sessions: { others: "none" }, scopes: RW },
  reader: { agents: "*", sessions: { others: "none" }, scopes: ["operator.read"] },
  administrator: { agents: "*", sessions: { others: "write" }, scopes: ["operator.admin"] },
};
const rolesFor = (column: Column): GatewayOperatorRolesConfig | undefined =>
  column === "absent"
    ? undefined
    : {
        definitions,
        ...(column === "default" ? { default: "operator" } : {}),
      };
async function settled<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function fixture(row: Row, column: Column, signal: AbortSignal, password = false) {
  const state = await createOpenClawTestState(
    kernelGatewayTestStateOptions(`role-scope-${row}-${column}`),
  );
  const clients: Client[] = [];
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const requests: string[] = [];
  const accessRequests: string[] = [];
  let access: { mockRestore: () => void } | undefined;
  // external-io-fixture: captured local Responses provider; auth, profiles,
  // membership signatures/store, session router, and turn execution remain real.
  const provider = createServer((req, res) => {
    void readRequestText(req).then((body) => {
      requests.push(body);
      writeOpenAiResponsesText(res, {
        text: "Scope matrix reply.",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    });
  });
  const peers = new Map<string, ReturnType<typeof formatIrohEndpointKey>>();
  // Transport-only seam: emulate the tunnel listener's authenticated peer stamp.
  // No principal resolver or membership result is replaced.
  // oxlint-disable-next-line typescript/unbound-method -- preserve the HTTP server receiver.
  const emit = http.Server.prototype.emit;
  const transport = vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
    this: http.Server,
    event,
    ...args
  ) {
    if (event === "upgrade" || event === "request") {
      const req = args[0] as IncomingMessage;
      const peerKey = peers.get(req.headers.origin ?? "");
      if (peerKey) {
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey,
          clientIp: "fd7a:115c:a1e0::9",
        });
      }
    }
    return emit.call(this, event, ...args);
  });
  const tlsTransport = vi
    .spyOn(https.Server.prototype, "emit")
    .mockImplementation(transport.getMockImplementation()!);
  const close = async () => {
    for (const client of clients) {
      await client.stopAndWait();
    }
    await server?.close();
    transport.mockRestore();
    tlsTransport.mockRestore();
    access?.mockRestore();
    await closeProvider(provider);
    await state.cleanup();
  };
  try {
    const member = row.startsWith("member");
    const proxy = row === "proxy" || row === "cloudflare" || row === "member-proxy";
    const cloudflare = row === "cloudflare";
    const userHeader = cloudflare ? "cf-access-authenticated-user-email" : "x-forwarded-user";
    const targetEmail = "scope-person@example.test";
    const adminEmail = "scope-admin@example.test";
    const token = "scope-matrix-local-secret";
    const origin = "http://scope-matrix.test";
    const tunnelOrigin = "http://scope-member.test";
    const ownerOrigin = "http://scope-owner.test";
    const port = await getFreePort();
    const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "scope-matrix");
    const auth: GatewayAuthConfig = proxy
      ? {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader,
            requiredHeaders: [cloudflare ? "cf-access-jwt-assertion" : "x-forwarded-proto"],
            allowLoopback: true,
            allowUsers: [targetEmail, adminEmail],
            deviceAutoApprove: { enabled: true, scopes: ALL },
          },
          identityScopes: { [targetEmail]: ALL, [adminEmail]: ALL },
        }
      : row === "local"
        ? { mode: "none" }
        : password
          ? { mode: "password", password: token }
          : { mode: "token", token };
    const tls = proxy
      ? {
          enabled: true,
          autoGenerate: false,
          certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
          keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
        }
      : undefined;
    await state.writeConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      gateway: {
        mode: "local",
        bind: "loopback",
        auth,
        tls,
        roles: rolesFor(column),
        ...(member ? { openclawId: { enabled: true } } : {}),
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: { allowedOrigins: [origin, tunnelOrigin, ownerOrigin] },
      },
    });
    const target = await ensureCanonicalUserProfileForEmail(targetEmail);
    const admin = await ensureCanonicalUserProfileForEmail(adminEmail);
    await setCanonicalUserProfileRole(admin.id, "administrator");
    await ensureCanonicalGatewayOwnerProfile("Scope owner");
    if (member) {
      await linkCanonicalOpenClawIdUserProfile({
        profileId: target.id,
        accountId: "acct-scope-member",
        email: targetEmail,
      });
      const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
      peers.set(ownerOrigin, claw.w1);
      const peerKey = formatIrohEndpointKey((await generateEd25519Signer()).publicKey);
      peers.set(tunnelOrigin, peerKey);
      expect(
        await claw.authority.submit(
          await claw.sign({
            op: "add",
            account_id: "acct-scope-member",
            role: "operator",
            peer_keys: [peerKey],
            invite_id: null,
          }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
      await claw.authority.bindToken("scope-seed", "operator", peerKey);
    }
    server = await startGatewayServerCore(port, { bind: "loopback", controlUiEnabled: false });
    if (cloudflare) {
      // Access verification uses the bundled GitHub public bounded-response facade.
      // Enable that real leaf after startup, without loading unrelated plugins.
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.resolve("extensions");
    }
    const fetch = globalThis.fetch;
    // external-io-fixture: Access's identity service is external; keep its actual
    // JWT parsing, provider validation, canonical profile resolution and auth route.
    access =
      row === "cloudflare"
        ? vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            if (
              (typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url) === "https://scope.cloudflareaccess.com/cdn-cgi/access/get-identity"
            ) {
              const cookie = new Headers(init?.headers).get("Cookie")!;
              const claims = JSON.parse(
                Buffer.from(cookie.split(".")[1]!, "base64url").toString(),
              ) as { email: string };
              accessRequests.push(claims.email);
              return Response.json({ email: claims.email, idp: { type: "onetimepin" } });
            }
            return fetch(input, init);
          })
        : undefined;
    if (member) {
      await expect
        .poll(() => getRuntimeConfig().gateway?.roles?.definitions.operator)
        .toBeDefined();
    }
    const headers = (email: string, ceiling?: string) => ({
      "x-forwarded-for": "203.0.113.51",
      "x-forwarded-proto": "https",
      [userHeader]: email,
      ...(cloudflare
        ? {
            "cf-access-jwt-assertion": `header.${Buffer.from(JSON.stringify({ iss: "https://scope.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600, email })).toString("base64url")}.signature`,
          }
        : {}),
      ...(ceiling !== undefined ? { "x-openclaw-scopes": ceiling } : {}),
    });
    const identity = loadOrCreateDeviceIdentity({
      path: state.statePath("scope-target", "client", "credentials.sqlite"),
    });
    const connect = async (
      kind: "target" | "admin" | "device" = "target",
      deviceToken?: string,
      ceiling?: string,
    ) => {
      let scopes: string[] = [];
      let issuedToken: string | undefined;
      const connection = {
        url: `${proxy ? "wss" : "ws"}://127.0.0.1:${port}`,
        ...(proxy ? { tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256 } : {}),
        origin:
          kind === "admin" && member
            ? ownerOrigin
            : row === "member" && kind === "target"
              ? tunnelOrigin
              : origin,
        ...(proxy && !(kind === "admin" && member)
          ? { edgeAuthHeaders: headers(kind === "admin" ? adminEmail : targetEmail, ceiling) }
          : {}),
        ...(!proxy && row !== "local" && !member && kind !== "device"
          ? password
            ? { password: token }
            : { token }
          : {}),
        ...(kind === "device" ? { deviceToken } : {}),
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        ...(kind !== "admin" ? { deviceIdentity: identity } : {}),
        scopes: kind === "device" ? RW : ALL,
        timeoutMs: 6000,
        signal,
        onHelloOk: (hello: import("../../packages/gateway-protocol/src/index.js").HelloOk) => {
          scopes = hello.auth?.scopes ?? [];
          issuedToken = hello.auth?.deviceToken;
        },
      };
      const client = password
        ? await acquireGatewayTestClient(connection, {
            timeoutMs: 6000,
            timeoutMessage: "password connection timed out",
            closeMessage: "password connection closed",
            signal,
          })
        : await connectGatewayClient(connection);
      clients.push(client);
      return { client, scopes: scopes.toSorted(), issuedToken };
    };
    const ownProfileId = row === "local" || row === "token" ? "gateway-owner" : target.id;
    const ownKey = "agent:main:scope-own";
    const foreignKey = "agent:main:scope-foreign";
    for (const [sessionKey, id] of [
      [ownKey, ownProfileId],
      [foreignKey, admin.id],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id },
        },
      );
    }
    const exercise = async (connected: Awaited<ReturnType<typeof connect>>) => {
      const self = await connected.client.request<{ profile: { id: string } }>("users.self", {});
      const listed = await connected.client.request<{ sessions: Array<{ key: string }> }>(
        "sessions.list",
        {},
      );
      const marker = `SCOPE_MATRIX_${randomUUID()}`;
      const readerAssignment = row.startsWith("member") && column === "assignment";
      const sent = readerAssignment
        ? await settled(
            connected.client.request("chat.send", {
              sessionKey: ownKey,
              message: marker,
              idempotencyKey: randomUUID(),
            }),
          )
        : await settled(sendChatAndWait(connected.client, ownKey, marker, 20_000));
      if (readerAssignment) {
        expect(sent).toEqual({ ok: false, error: "missing scope: operator.write" });
      }
      return {
        scopes: connected.scopes,
        profile: self.profile.id === ownProfileId,
        visible: {
          own: listed.sessions.some((s) => s.key === ownKey),
          foreign: listed.sessions.some((s) => s.key === foreignKey),
        },
        send: sent.ok,
        captured: requests.some((body) => body.includes(marker)),
        ...(!sent.ok ? { sendError: sent.error } : {}),
      };
    };
    return {
      close,
      connect,
      exercise,
      ownProfileId,
      target,
      column,
      row,
      requests,
      accessRequests,
      runtimeRoles: () => getRuntimeConfig().gateway?.roles,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function expected(row: Row, column: Column) {
  if (row === "local" && column === "default") {
    return { connected: false };
  }
  const member = row.startsWith("member");
  const restricted = member || ((row === "proxy" || row === "cloudflare") && column === "default");
  const scopes =
    member && column === "absent"
      ? PRESET
      : member && column === "assignment"
        ? ["operator.read"]
        : row === "member"
          ? // A tunnel member connects with its role's scopes, whatever it asked for.
            RW
          : restricted
            ? // Pinned base operator-scope-compat.ts: operator.write grants requested talk.
              [...RW, "operator.talk"]
            : ALL;
  const send = !(member && column === "assignment");
  return {
    connected: true,
    scopes: scopes.toSorted(),
    profile: true,
    visible: { own: true, foreign: !restricted || (member && column === "absent") },
    send,
    captured: send,
  };
}

it.for(ROWS.flatMap((row) => COLUMNS.map((column) => ({ row, column }))))(
  "scope matrix $row / $column",
  { timeout: 60_000 },
  async ({ row, column }, { signal }) => {
    const f = await fixture(row, column, signal);
    try {
      let assignment: Awaited<ReturnType<typeof settled>> | undefined;
      if (column === "assignment") {
        const admin = await f.connect("admin");
        assignment = await settled(
          admin.client.request("users.setRole", { profileId: f.ownProfileId, role: "reader" }),
        );
        expect
          .soft(assignment.ok, `${row}: catalog-only users.setRole`)
          .toBe(row.startsWith("member"));
        if (!row.startsWith("member") && row !== "local" && row !== "token") {
          expect
            .soft(assignment.ok ? "accepted" : assignment.error)
            .toContain("gateway.roles.default");
        }
      }
      const connection = await settled(f.connect());
      const report = connection.ok
        ? { connected: true, ...(await f.exercise(connection.value)) }
        : { connected: false, error: connection.error };
      console.log(
        "SCOPE_MATRIX",
        JSON.stringify({
          row,
          column,
          assignment,
          runtimeRoleNames: Object.keys(f.runtimeRoles()?.definitions ?? {}),
          report,
        }),
      );
      if (row === "cloudflare") {
        expect(f.accessRequests).toContain("scope-person@example.test");
      }
      if (row === "local" && column === "default") {
        expect(connection.ok ? "connected" : connection.error).toContain(
          "operator role policies require a verified user identity",
        );
      }
      const {
        error: _error,
        sendError: _sendError,
        ...observable
      } = report as typeof report & { error?: string; sendError?: string };
      expect(observable).toEqual(expected(row, column));
    } finally {
      await f.close();
    }
  },
);

it.for(COLUMNS)("owner HTTP and Web Push base contract / %s", async (column) => {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  try {
    await ensureCanonicalGatewayOwnerProfile("Scope owner");
    const cfg = { gateway: { roles: rolesFor(column) } };
    const catalog = await prepareUserProfileCatalog();
    try {
      for (const method of ["none", "token", "password"] as const) {
        const req = new IncomingMessage(new Socket());
        const result = await checkAuthenticatedHttpUserProfile({
          req,
          cfg,
          getRuntimeConfig: () => cfg,
          authResult: { ok: true, method },
        });
        const profile = result.ok ? result.profile.authenticatedUserProfile?.profileId : null;
        console.log("SCOPE_HTTP", JSON.stringify({ column, method, profile }));
        expect
          .soft(profile, `${column}/${method}`)
          .toBe(column === "default" && method === "none" ? null : "gateway-owner");
      }
      const push = listCurrentWebPushTargets({
        cfg,
        profile: catalog,
        sessions: new Map(),
        preferences: new Map(),
        devicePeer: () => undefined,
        principal: () => undefined,
        subscriptions: [
          {
            subscriptionId: "scope-sub",
            deviceId: "scope-device",
            userProfileId: "gateway-owner",
            devicePreferences: { enabled: true, label: "Scope device" },
            endpoint: "https://push.example.test/scope",
            keys: { p256dh: "fixture", auth: "fixture" },
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
        pairedDevices: [
          {
            deviceId: "scope-device",
            publicKey: "fixture",
            roles: ["operator"],
            approvedScopes: RW,
            scopes: RW,
            createdAtMs: 1,
            approvedAtMs: 1,
            tokens: {
              operator: { token: "fixture", role: "operator", scopes: RW, createdAtMs: 1 },
            },
          },
        ],
        requiredScopes: ["operator.read"],
      });
      console.log("SCOPE_PUSH", JSON.stringify({ column, eligible: push.length }));
      expect(push).toHaveLength(column === "default" ? 0 : 1);
    } finally {
      catalog.release();
    }
  } finally {
    await state.cleanup();
  }
});

it("device-token gateway-owner read+write without admin / catalog", async ({ signal }) => {
  const f = await fixture("token", "catalog", signal);
  try {
    const paired = await f.connect();
    expect(paired.issuedToken).toBeTruthy();
    await paired.client.stopAndWait();
    const device = await f.connect("device", paired.issuedToken);
    const report = await f.exercise(device);
    console.log("SCOPE_DEVICE", JSON.stringify(report));
    expect(report).toEqual({
      scopes: RW.toSorted(),
      profile: true,
      visible: { own: true, foreign: true },
      send: true,
      captured: true,
    });
  } finally {
    await f.close();
  }
}, 60_000);

it("healthy proxy with empty header ceiling keeps base health recovery / default", async ({
  signal,
}) => {
  const f = await fixture("proxy", "default", signal);
  try {
    const connected = await settled(f.connect("target", undefined, ""));
    console.log(
      "SCOPE_EMPTY",
      JSON.stringify(
        connected.ok ? { connected: true, scopes: connected.value.scopes } : connected,
      ),
    );
    expect(connected.ok).toBe(true);
    if (connected.ok) {
      expect(connected.value.scopes).toEqual([]);
      await expect(connected.value.client.request("health", {})).resolves.toBeDefined();
    }
  } finally {
    await f.close();
  }
}, 60_000);

it("shared password companion retains owner authority / catalog", async ({ signal }) => {
  const f = await fixture("token", "catalog", signal, true);
  try {
    const connected = await f.connect();
    const report = { connected: true, ...(await f.exercise(connected)) };
    console.log("SCOPE_PASSWORD", JSON.stringify(report));
    expect(report).toEqual(expected("token", "catalog"));
  } finally {
    await f.close();
  }
}, 60_000);
