import { get, type IncomingMessage } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalOpenClawIdUserProfile,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { startOpenClawIdIngressListener } from "./openclaw-id/ingress-listener.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayHttpServer } from "./server-http.js";

const member: OpenClawIdTunnelPrincipal = {
  kind: "member",
  peerKey: `iroh:${"ab".repeat(32)}`,
  accountId: "history-member",
  role: "viewer",
};
const owner: OpenClawIdTunnelPrincipal = { kind: "owner", peerKey: `iroh:${"cd".repeat(32)}` };
const principals = new Map([member, owner].map((principal) => [principal.peerKey, principal]));
const text = "Shared conversation history";
const email = "history-member@example.test";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: ReturnType<typeof createGatewayHttpServer>;
let ingress: Awaited<ReturnType<typeof startOpenClawIdIngressListener>>;
let cfg: OpenClawConfig;
let url: string;
let memberId: string;
let foreignId: string;
let sequence = 0;

beforeAll(async () => {
  state = await createOpenClawTestState({
    scenario: "minimal",
    label: "http-history-membership",
    prepareProfileCatalog: true,
  });
  cfg = {
    agents: { entries: { main: {} } },
    plugins: { enabled: false },
    gateway: {
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
      },
      roles: {
        default: "viewer",
        definitions: {
          viewer: { scopes: ["operator.sessions.read"], agents: [], sessions: { others: "none" } },
          staff: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  memberId = (await ensureCanonicalUserProfileForEmail(email)).id;
  await setCanonicalUserProfileRole(memberId, "staff");
  expect(
    await linkCanonicalOpenClawIdUserProfile({
      profileId: memberId,
      accountId: member.accountId,
      email,
    }),
  ).toEqual({ ok: true });
  foreignId = (await ensureCanonicalUserProfileForEmail("history-author@example.test")).id;
  setOpenClawIdTunnelPrincipalResolver(async (key) => principals.get(key));
  setOpenClawIdTunnelPrincipalLookup((key) => principals.get(key));
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  server = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "",
    handleHooksRequest: async () => false,
    resolvedAuth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
    getRuntimeConfig: () => cfg,
    getGatewayRequestContext: () => context,
    httpRequestLifetime: context,
  });
  url = await listenLoopback(server);
  ingress = await startOpenClawIdIngressListener({
    socketPath: path.join(state.stateDir, "history-id", "ingress.sock"),
    gatewayServer: () => server,
    log: { warn() {} },
  });
});

afterAll(async () => {
  setOpenClawIdTunnelPrincipalResolver(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
  try {
    await ingress?.close();
    if (server) {
      await closeHttpServer(server);
    }
  } finally {
    await state?.cleanup();
  }
});

async function tunnelHistory(peerKey: string, sessionKey: string, sse: boolean) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = get(
      {
        socketPath: ingress.socketPath,
        path: `/sessions/${encodeURIComponent(sessionKey)}/history`,
        headers: {
          "x-openclaw-id-proxy-token": ingress.proxyToken,
          "x-openclaw-id-peer-key": peerKey,
          ...(sse ? { accept: "text/event-stream" } : {}),
        },
      },
      resolve,
    );
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("History response timed out")));
  });
  let body = "";
  try {
    if (sse && response.statusCode === 200) {
      expect(response.headers["content-type"]).toContain("text/event-stream");
    }
    response.setEncoding("utf8");
    for await (const chunk of response) {
      body += chunk;
      if (sse && response.statusCode === 200) {
        const frame = body
          .split("\n\n")
          .slice(0, -1)
          .find((part) => part.startsWith("event: history\n"));
        if (frame) {
          return {
            status: response.statusCode,
            body: JSON.parse(expectDefined(frame.split("\ndata: ")[1], "history event data")),
          };
        }
      }
    }
    if (sse && response.statusCode === 200) {
      throw new Error("History stream ended before its history event");
    }
    return { status: response.statusCode, body: JSON.parse(body) };
  } finally {
    response.destroy();
  }
}

function setMemberAccess(others: "none" | "view") {
  cfg = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      roles: {
        default: "viewer",
        definitions: {
          ...cfg.gateway?.roles?.definitions,
          viewer: { scopes: ["operator.sessions.read"], agents: [], sessions: { others } },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
}

it.each([false, true])("keeps the membership ceiling for HTTP history (SSE: %s)", async (sse) => {
  setMemberAccess("none");
  const sessionId = `history-membership-${++sequence}`;
  const scope = { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}` };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: sequence,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: foreignId },
  });
  await appendTranscriptMessage(scope, {
    eventId: `${sessionId}-message`,
    message: { role: "user", content: text },
  });
  const readable = { status: 200, body: { messages: [{ role: "user", content: text }] } };
  expect(await tunnelHistory(owner.peerKey, scope.sessionKey, sse)).toMatchObject(readable);
  const local = await fetch(`${url}/sessions/${encodeURIComponent(scope.sessionKey)}/history`, {
    headers: {
      "x-forwarded-for": "192.0.2.10",
      "x-forwarded-proto": "https",
      "x-forwarded-user": email,
    },
  });
  expect(local.status).toBe(200);
  expect(await local.json()).toMatchObject(readable.body);
  expect(await tunnelHistory(member.peerKey, scope.sessionKey, sse)).toMatchObject({
    status: 404,
    body: { error: { type: "not_found" } },
  });
  await addSessionMember(scope, { identityId: memberId, addedBy: foreignId });
  expect(await tunnelHistory(member.peerKey, scope.sessionKey, sse)).toMatchObject({ status: 404 });
  setMemberAccess("view");
  expect(await tunnelHistory(member.peerKey, scope.sessionKey, sse)).toMatchObject(readable);
});
