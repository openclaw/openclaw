import { readFile } from "node:fs/promises";
import {
  get as httpGet,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS,
  ensureControlUiAssetsBuilt,
} from "../infra/control-ui-assets.js";
import * as tailscale from "../infra/tailscale.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import { buildControlUiSessionEntryUrl } from "./control-ui-session-entry-path.js";
import * as documentTransport from "./control-ui-static.js";
import type { GatewayIngressTransport } from "./ingress-attribution.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

// Real HTTP, SQLite identity/access owners and built UI. Proxy identity and Tailscale
// whois are synthetic; document delivery is delayed only for live-revocation proof.
const basePath = "/control";
const [privateSession, publicSession] = (
  [
    ["12345678-aaaa-4000-8000-000000000001", "private-http-instance"],
    ["87654321-aaaa-4000-8000-000000000002", "public-http-instance"],
  ] as const
).map(([id, sessionId]) => ({
  route: "/control/chat/main/dashboard/" + id,
  scope: { agentId: "main", sessionKey: "agent:main:dashboard:" + id, sessionId },
}));
const { route: privatePath, scope: privateScope } = privateSession!;
const { route: publicPath, scope: publicScope } = publicSession!;
const entry = buildControlUiSessionEntryUrl(privatePath, basePath);
const memberEmail = "http-handoff-member@example.test";
const deniedEmail = "http-handoff-denied@example.test";
const ownerEmail = "http-handoff-owner@example.test";
const privateTitle = "Private HTTP handoff conversation";
const privateMessage = "Unpublished conversation text must not reach the anonymous document.";
const publishedMessage = "Published HTTP handoff conversation text.";
const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
const proxyHeaders = {
  host: "threads.example.test",
  "x-forwarded-for": "203.0.113.42",
  "x-forwarded-proto": "https",
  "x-openclaw-scopes": "operator.read",
};

const roleOptions = { onCommitted: invalidateOperatorRolePolicy };

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

function expectNoApp(response: HttpResult) {
  for (const privateContent of ["<openclaw-app", 'type="module"', privateTitle, privateMessage]) {
    expect(response.body).not.toContain(privateContent);
  }
}

function holdPreparedDocument() {
  const entered = createDeferred<{ body: string; res: ServerResponse; current: boolean }>();
  const resume = createDeferred();
  const send = documentTransport.sendControlUiHtmlBody;
  const spy = vi
    .spyOn(documentTransport, "sendControlUiHtmlBody")
    .mockImplementationOnce(async (req, res, body, isCurrent) => {
      // Pause after real preparation, before encoding and final live-authority delivery.
      entered.resolve({ body, res, current: isCurrent?.() === true });
      await resume.promise;
      await send(req, res, body, isCurrent);
    });
  return { entered: entered.promise, resume: resume.resolve, restore: () => spy.mockRestore() };
}

describe("real HTTP authentication to canonical thread app delivery", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  const listeners: Awaited<
    ReturnType<typeof reserveTestPortListener<ReturnType<typeof createGatewayHttpServer>>>
  >[] = [];
  let projection: SessionRowProjection | undefined;
  let memberId: string;
  let ownerId: string;
  let index: string;
  let port: number;
  let auth: ResolvedGatewayAuth;

  let signal: AbortSignal;
  const whois = vi.spyOn(tailscale, "readTailscaleWhoisIdentity");
  async function request(
    route: string,
    identity?: string | Record<string, string>,
    targetPort = port,
  ) {
    const headers =
      typeof identity === "string" ? { ...proxyHeaders, "x-forwarded-user": identity } : identity;
    // Native fetch replaces Host with the URL authority; these ingress cases need the wire header.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpGet(
        "http://127.0.0.1:" + targetPort + route,
        {
          signal,
          headers: { ...(headers ?? proxyHeaders), "accept-encoding": "gzip", connection: "close" },
        },
        resolve,
      ).once("error", reject);
    });
    const body = await buffer(response);
    return {
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: (response.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString(
        "utf8",
      ),
    };
  }
  beforeEach((context) => {
    signal = context.signal;
    auth = { mode: "trusted-proxy", trustedProxy, allowTailscale: false };
    whois.mockReset();
  });
  beforeAll(async () => {
    const assets = await ensureControlUiAssetsBuilt(undefined, { root: process.cwd() });
    if (!assets.ok) {
      throw new Error(assets.message);
    }
    const root = path.resolve("dist/control-ui");
    index = await readFile(path.join(root, "index.html"), "utf8");
    expect(index).toContain("<openclaw-app");
    expect(index).toContain('type="module"');
    state = await createOpenClawTestState({
      scenario: "minimal",
      label: "session-entry-real-auth",
    });
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        publicOrigin: "https://threads.example.test",
        auth: { mode: "trusted-proxy", trustedProxy },
        trustedProxies: ["127.0.0.1"],
        controlUi: { basePath },
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", sessions: { others: "view" }, scopes: ["operator.read"] },
            denied: { agents: "*", sessions: { others: "none" }, scopes: ["operator.read"] },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg, cfg);
    ownerId = (await ensureCanonicalUserProfileForEmail(ownerEmail)).id;
    memberId = (await ensureCanonicalUserProfileForEmail(memberEmail)).id;
    const deniedId = (await ensureCanonicalUserProfileForEmail(deniedEmail)).id;
    await setCanonicalUserProfileRole(deniedId, "denied", roleOptions);
    for (const [scope, displayName, content, fields] of [
      [privateScope, privateTitle, privateMessage, { visibility: "read-only" }],
      [
        publicScope,
        "Public HTTP handoff conversation",
        publishedMessage,
        {
          publicShare: { id: "a".repeat(48), sessionId: publicScope.sessionId, createdAt: 1 },
        },
      ],
    ] as const) {
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: scope === privateScope ? 1 : 2,
        displayName,
        createdActor: { type: "human", source: "profile", id: ownerId },
        ...fields,
      });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        { type: "message", id: `${scope.sessionId}-message`, message: { role: "user", content } },
      ]);
    }
    await addSessionMember(privateScope, { identityId: memberId, addedBy: ownerId });
    projection = await createSessionRowProjection({ cfg, getConfig: () => cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    // Context stubs unrelated scheduler/WS services, not projection/auth/access owners.
    const context = createGatewayRequestContext(makeContextParams());
    context.resolveGatewayContext = () => context;
    bindSessionRowProjection(context, () => projection);
    const createServer = (ingressTransport?: GatewayIngressTransport) =>
      createGatewayHttpServer({
        ingressTransport,
        clients: new Set(),
        controlUiEnabled: true,
        controlUiBasePath: basePath,
        controlUiRoot: { kind: "resolved", path: root },
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        resolvedAuth: auth,
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => cfg,
        getGatewayRequestContext: () => context,
        httpRequestLifetime: context,
        isTerminalEnabled: () => false,
      });
    for (const ingress of [undefined, { kind: "managed-tailscale", mode: "serve" }] as const) {
      listeners.push(
        await reserveTestPortListener({
          offsets: [0],
          createListener: () => createServer(ingress),
        }),
      );
    }
    port = listeners[0]!.claim.port;
  }, CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      for (const server of listeners) {
        server.listener.closeAllConnections();
        try {
          await server.releaseListener();
        } finally {
          await server.claim.release();
        }
      }
    } finally {
      projection?.dispose();
      await state?.cleanup();
    }
  });

  for (const mode of ["token", "password"] as const) {
    it(`reopens private ${mode} chat links through the real HTTP entry`, async () => {
      auth = {
        mode,
        token: "synthetic-token",
        password: "synthetic-password",
        allowTailscale: false,
      };
      for (const headers of [{ host: "localhost" }, proxyHeaders]) {
        const response = await request(privatePath, headers);
        expect(response.status).toBe(404);
        expectNoApp(response);
        expect(response.body).toContain('data-gateway-path="/control"');
        expect((await request(entry + "&probe=1", headers)).status).toBe(401);
        const app = await request(entry, headers);
        expect(app.status).toBe(200);
        expect(app.body).toContain("<openclaw-app");
        expect(app.headers["x-openclaw-session-entry"]).toBeUndefined();
      }
      const nonSecure = await request(privatePath, { host: "gateway.lan" });
      expect(nonSecure.status).toBe(200);
      expect(nonSecure.body).toContain("<openclaw-app");
      expect(nonSecure.body).not.toContain(privateMessage);
      const published = await request(publicPath);
      expect(published.status).toBe(200);
      expect(published.body).toContain(publishedMessage);
      expectNoApp(published);
    });
  }

  it.each(["x-forwarded-user", "tailscale-user-login"] as const)(
    "delivers authorized app documents and denies inaccessible sessions using %s",
    async (identityHeader) => {
      const managed = identityHeader === "tailscale-user-login";
      let ingressHeaders: Record<string, string> = proxyHeaders;
      if (managed) {
        auth = { mode: "token", token: "synthetic-token", allowTailscale: true };
        ingressHeaders = {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.10",
          "x-forwarded-host": "threads.example.test",
          "sec-fetch-site": "same-origin",
        };
      }
      const targetPort = managed ? listeners[1]!.claim.port : port;
      const headersFor = (email: string) => ({ ...ingressHeaders, [identityHeader]: email });
      whois.mockResolvedValue({ login: memberEmail, name: "Member" });
      const anonymous = await request(privatePath, headersFor(memberEmail), targetPort);
      expect(anonymous.status).toBe(404);
      expectNoApp(anonymous);
      for (const email of [ownerEmail, memberEmail, deniedEmail]) {
        whois.mockResolvedValue({ login: email, name: "Viewer" });
        const headers = headersFor(email);
        const probe = await request(entry + "&probe=1", headers, targetPort);
        const response = await request(entry, headers, targetPort);
        if (email === deniedEmail) {
          // 403, not 401, proves identity admission before session access denial.
          for (const denied of [probe, response]) {
            expect(denied.status).toBe(403);
            expectNoApp(denied);
            expect(denied.headers.location).toBeUndefined();
            expect(denied.headers["x-openclaw-session-entry"]).toBeUndefined();
          }
          expect(response.body).toContain("Session unavailable");
          continue;
        }
        expect(probe.status).toBe(204);
        expect(response.status).toBe(200);
        expect(response.body).toContain("<openclaw-app");
        expect(response.body).toContain('type="module"');
        const moduleSource = index.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/u)?.[1];
        expect(moduleSource).toBeTruthy();
        expect(response.body).toContain(moduleSource!.replace("./assets/", basePath + "/assets/"));
        expect(response.body).toContain(
          `history.replaceState(null,"","${privatePath}"+location.hash)`,
        );
        expect(response.body.indexOf("history.replaceState")).toBeLessThan(
          response.body.indexOf('type="module"'),
        );
        expect(response.headers).toMatchObject({
          "cache-control": "private, no-store",
          "content-encoding": "gzip",
          "x-openclaw-session-entry": "1",
        });
        expect(response.headers["content-security-policy"]).toContain(
          "connect-src 'self' ws: wss:",
        );
        for (const hash of computeInlineScriptHashes(response.body)) {
          expect(response.headers["content-security-policy"]).toContain(hash);
        }
      }
      if (managed) {
        // Forwarded headers cannot substitute for verified identity or managed ingress.
        const headers = headersFor(memberEmail);
        expect((await request(entry + "&probe=1", headers, targetPort)).status).toBe(401);
        whois.mockResolvedValue({ login: memberEmail, name: "Member" });
        expect((await request(entry + "&probe=1", headers)).status).toBe(401);
      }
    },
  );

  it("ignores spoofed identity on anonymous canonical documents while protecting the handoff", async () => {
    for (const [route, status] of [
      [publicPath, 200],
      [privatePath, 404],
    ] as const) {
      const anonymous = await request(route);
      const spoofed = await request(route, ownerEmail);
      expect(anonymous.status).toBe(status);
      expect(spoofed.status).toBe(status);
      expect(spoofed.body).toBe(anonymous.body);
      expectNoApp(spoofed);
      if (route === publicPath) {
        expect(anonymous.body).toContain(publishedMessage);
      }
    }
    for (const route of [
      entry,
      entry + "&probe=1",
      basePath + "/__openclaw__/assistant-media?source=missing.png",
    ]) {
      const protectedResponse = await request(route);
      expect(protectedResponse.status).toBe(401);
      expectNoApp(protectedResponse);
    }
  });

  for (const change of ["visibility", "role"] as const) {
    it(`withholds all app bytes when ${change} changes after real document preparation`, async () => {
      await addSessionMember(privateScope, { identityId: memberId, addedBy: ownerId });
      const held = holdPreparedDocument();
      const pending = request(entry, memberEmail);
      try {
        const prepared = await withinTest(
          awaitGateBeforeSettlement(
            held.entered,
            pending,
            "HTTP request ended before authorized app preparation",
          ),
          signal,
        );
        expect(prepared.current).toBe(true);
        expect(prepared.body).toContain("<openclaw-app");
        expect(prepared.res.headersSent).toBe(false);
        if (change === "visibility") {
          // Membership alone does not grant or revoke this role's read access.
          await patchSessionEntryCore(privateScope, () => ({ visibility: "draft" }));
        } else {
          await setCanonicalUserProfileRole(memberId, "denied", roleOptions);
        }
        expect(prepared.res.headersSent).toBe(false);
        held.resume();
        const response = await pending;
        expect(response.status).toBe(403);
        expect(response.headers.location).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-encoding"]).toBeUndefined();
        expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(response.headers["content-security-policy"]).toBeUndefined();
        expect(response.body).toContain("Session access changed");
        expectNoApp(response);
      } finally {
        held.resume();
        await Promise.allSettled([pending]);
        held.restore();
        if (change === "visibility") {
          await patchSessionEntryCore(privateScope, () => ({ visibility: "read-only" }));
        }
        await setCanonicalUserProfileRole(memberId, null, roleOptions);
      }
    });
  }
});
