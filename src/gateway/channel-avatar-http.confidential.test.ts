import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { channelAvatarRevision } from "./channel-avatar-reference.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";

const media = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../media/media-reference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/media-reference.js")>()),
  resolveInboundMediaReference: async () => ({ id: "confidential-avatar.png" }),
}));
vi.mock("../media/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/store.js")>()),
  readMediaBuffer: (...args: unknown[]) => media.read(...args),
}));
const { handleChannelAvatarHttpRequest } = await import("./channel-avatar-http.js");
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const emails = {
  creator: "avatar-creator@example.test",
  selected: "avatar-selected@example.test",
  outsider: "avatar-outsider@example.test",
  uninvited: "avatar-uninvited@example.test",
};
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: ReturnType<typeof createServer>;
let releaseProfiles: () => void;
let cfg: OpenClawConfig;
let port: number;
let storePath: string;
let sequence = 0;
const profiles = new Map<keyof typeof emails, string>();

beforeAll(async () => {
  state = await createOpenClawTestState({
    scenario: "minimal",
    label: "confidential-channel-avatar",
    prepareProfileCatalog: true,
  });
  for (const actor of Object.keys(emails) as (keyof typeof emails)[]) {
    profiles.set(actor, (await ensureCanonicalUserProfileForEmail(emails[actor])).id);
  }
  releaseProfiles = (await prepareUserProfileCatalog()).release;
  storePath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
  server = createServer((req, res) => {
    void handleChannelAvatarHttpRequest(req, res, {
      cfg,
      auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
      trustedProxies: cfg.gateway?.trustedProxies,
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 418;
          res.end();
        }
      })
      .catch(() => finishFailedGatewayHttpResponse(res));
  });
  port = Number(new URL(await listenLoopback(server)).port);
});
beforeEach(() => {
  cfg = {
    agents: { entries: { main: {} } },
    plugins: { enabled: false },
    gateway: {
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  media.read.mockReset().mockResolvedValue({ buffer: bytes });
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  releaseProfiles?.();
  await state?.cleanup();
});
async function fixture(invited: boolean) {
  if (invited) {
    cfg.gateway!.roles = {
      default: "invited",
      definitions: {
        invited: {
          agents: "*",
          scopes: ["operator.read", "operator.write"],
          // @ts-expect-error Runtime invitation policy precedes config enum activation.
          sessions: { others: "invited" },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
  }
  const sessionId = "avatar-confidential-" + ++sequence;
  const scope = { agentId: "main", sessionId, sessionKey: "agent:main:" + sessionId };
  const reference = "/state/media/inbound/" + sessionId + ".png";
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: sequence,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: profiles.get("creator")! },
    access: {
      mode: "audience",
      profileIds: [profiles.get("selected")!, profiles.get("uninvited")!],
    },
    delivery: {
      kind: "external",
      route: { channel: "discord", target: { to: "user:1" } },
      context: { channel: "discord", to: "user:1" },
      origin: { provider: "discord", to: "user:1", avatar: reference },
    },
  });
  if (invited) {
    addSessionMember(scope, {
      identityId: profiles.get("selected")!,
      addedBy: profiles.get("creator")!,
      expectedSessionId: sessionId,
    });
  }
  const request = (actor: keyof typeof emails) =>
    fetch(
      "http://127.0.0.1:" +
        port +
        buildControlUiChannelAvatarUrl("", scope.sessionKey, channelAvatarRevision(reference)),
      {
        headers: {
          "x-forwarded-for": "192.0.2.10",
          "x-forwarded-proto": "https",
          "x-forwarded-user": emails[actor],
          "x-openclaw-scopes": "operator.read",
        },
      },
    );
  return { scope, request };
}
it.each([false, true])(
  "serves authorized avatar readers and denies excluded or uninvited profiles before media: invited=%s",
  async (invited) => {
    const { request } = await fixture(invited);
    const denied = await request("outsider");
    expect(denied.status).toBe(403);
    expect(media.read).not.toHaveBeenCalled();
    if (invited) {
      expect((await request("uninvited")).status).toBe(403);
      expect(media.read).not.toHaveBeenCalled();
    }
    for (const actor of ["creator", "selected"] as const) {
      const allowed = await request(actor);
      expect(allowed.status, allowed.status === 200 ? undefined : await allowed.text()).toBe(200);
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes);
    }
  },
);
it.each(["audience", "membership"] as const)(
  "refuses avatar bytes when %s is revoked during the awaited load",
  async (revocation) => {
    const { scope, request } = await fixture(revocation === "membership");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    media.read.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { buffer: bytes };
    });
    const pending = request("selected");
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "avatar media read");
      if (revocation === "membership") {
        expect(
          removeSessionMember(scope, profiles.get("selected")!, undefined, scope.sessionId),
        ).not.toBeNull();
      } else {
        await applySessionEntryCanonicalReplacements({
          agentId: scope.agentId,
          storePath,
          sessionKeys: [scope.sessionKey],
          update: (rows) => ({
            result: undefined,
            replacements: rows.map((row) => ({
              ...row,
              previousSessionKeys: [],
              accessMutation: true,
              entry: { ...row.entry, access: { mode: "creator" as const } },
            })),
          }),
        });
      }
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).not.toBe("image/png");
      expect(response.headers.get("etag")).toBeNull();
      expect(await response.text()).not.toContain(bytes.toString("base64"));
    } finally {
      release.resolve();
      await pending;
    }
  },
);
