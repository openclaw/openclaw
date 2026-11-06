import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { channelAvatarRevision } from "./channel-avatar-reference.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { handleWorkspaceIconHttpRequest } from "./workspace-icon-http.js";

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
let projection: SessionRowProjection | undefined;
const projectionContext = bindSessionRowProjection({}, () => projection);
let useLiveGetter = true;
let sourceTrace: Record<string, unknown>[] = [];
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
    const captured = cfg;
    const handle = req.url?.startsWith("/__openclaw__/workspace-icon/")
      ? handleWorkspaceIconHttpRequest
      : handleChannelAvatarHttpRequest;
    void handle(req, res, {
      ...projectionContext,
      cfg: captured,
      getRuntimeConfig: useLiveGetter ? () => cfg : undefined,
      auth: resolveGatewayAuth({ authConfig: captured.gateway?.auth }),
      trustedProxies: captured.gateway?.trustedProxies,
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
  useLiveGetter = true;
  sourceTrace = [];
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
afterEach(() => {
  projection?.dispose();
  projection = undefined;
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  const tracePath = process.env.OPENCLAW_TEST_IMAGE_POLICY_TRACE_PATH;
  if (tracePath) {
    const tree = process.env.OPENCLAW_TEST_EVIDENCE_TREE;
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    appendFileSync(
      tracePath,
      sourceTrace.map((row) => JSON.stringify({ tree, ...row }) + "\n").join(""),
    );
  }
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

type ImageConsumer = "avatar" | "workspace icon";
async function sourceFixture(consumer: ImageConsumer) {
  const sessionId = "source-image-" + ++sequence;
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:telegram:group:-100123:topic:" + sequence,
  };
  cfg = {
    ...cfg,
    agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
    gateway: {
      ...cfg.gateway,
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
        },
      },
    },
    session: {
      sharing: {
        accessPolicy: {
          default: "creator",
          groups: [
            {
              agentId: "main",
              channel: "telegram",
              peerId: "-100123",
              profileIds: [profiles.get("selected")!],
            },
          ],
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const root = path.join(state.workspaceDir, sessionId);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "favicon.png"), bytes);
  const reference = "/state/media/inbound/" + sessionId + ".png";
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: sequence,
    visibility: "shared",
    spawnedCwd: root,
    createdActor: { type: "human", source: "profile", id: profiles.get("creator")! },
    access: { mode: "source" },
    delivery: {
      kind: "external",
      route: { channel: "telegram", target: { to: "-100123" } },
      context: { channel: "telegram", to: "-100123" },
      origin: { provider: "telegram", to: "-100123", avatar: reference },
    },
  });
  if (consumer === "workspace icon") {
    setActivePluginRegistry(createEmptyPluginRegistry());
    setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(), {
      config: cfg,
      compatibleConfigs: [cfg],
    });
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  }
  const route =
    consumer === "avatar"
      ? buildControlUiChannelAvatarUrl("", scope.sessionKey, channelAvatarRevision(reference))
      : "/__openclaw__/workspace-icon/" + encodeURIComponent(scope.sessionKey);
  const request = async (actor: "creator" | "selected" | "outsider") => {
    const response = await fetch("http://127.0.0.1:" + port + route, {
      headers: {
        "x-forwarded-for": "192.0.2.10",
        "x-forwarded-proto": "https",
        "x-forwarded-user": emails[actor],
        "x-openclaw-scopes": "operator.read",
      },
    });
    const body = Buffer.from(await response.arrayBuffer());
    sourceTrace.push({
      atUTC: new Date().toISOString(),
      kind: "http.response",
      consumer,
      actor,
      status: response.status,
      responseBytes: body.byteLength,
      imageBytesServed: body.equals(bytes),
      contentType: response.headers.get("content-type"),
      etagPresent: response.headers.has("etag"),
    });
    return { response, body };
  };
  return { scope, request };
}

it.each(["avatar", "workspace icon"] as const)(
  "serves source-selected/creator and excludes nonmembers for %s",
  async (consumer) => {
    const { request } = await sourceFixture(consumer);
    const read = vi.spyOn(boundaryFileRead, "readFileDescriptorBounded");
    const denied = await request("outsider");
    expect(denied.response.status).toBe(403);
    expect(denied.body.includes(bytes)).toBe(false);
    expect(media.read).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    for (const actor of ["creator", "selected"] as const) {
      const allowed = await request(actor);
      expect(allowed.response.status, allowed.body.toString()).toBe(200);
      expect(allowed.body).toEqual(bytes);
    }
  },
);

it.each([
  ["avatar", true],
  ["avatar", false],
  ["workspace icon", true],
  ["workspace icon", false],
] as const)(
  "refuses config-only source revocation during %s read with live getter=%s",
  async (consumer, suppliedGetter) => {
    useLiveGetter = suppliedGetter;
    const { scope, request } = await sourceFixture(consumer);
    const persisted = loadSessionEntry(scope);
    const captured = cfg;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    if (consumer === "avatar") {
      media.read.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { buffer: bytes };
      });
    } else {
      const actualRead = boundaryFileRead.readFileDescriptorBounded;
      vi.spyOn(boundaryFileRead, "readFileDescriptorBounded").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return await actualRead(...args);
        },
      );
    }
    const pending = request("selected");
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "source image read");
      cfg = {
        ...cfg,
        session: {
          sharing: {
            accessPolicy: {
              default: "creator",
              groups: captured.session!.sharing!.accessPolicy!.groups!.map((group) =>
                Object.assign({}, group, { profileIds: [] }),
              ),
            },
          },
        },
      };
      // The supplied Gateway config owner can advance before the global snapshot.
      if (!suppliedGetter) {
        setRuntimeConfigSnapshot(cfg);
      }
      expect(captured.session!.sharing!.accessPolicy!.groups![0]!.profileIds).toContain(
        profiles.get("selected")!,
      );
      expect(loadSessionEntry(scope)).toEqual(persisted);
      sourceTrace.push({
        atUTC: new Date().toISOString(),
        kind: "config.publication",
        consumer,
        suppliedGetter,
        publicationOwner: suppliedGetter ? "gateway config getter" : "runtime snapshot",
        capturedSelected: true,
        liveSelected: false,
        storedAccess: "source",
      });
      release.resolve();
      const denied = await pending;
      expect(denied.response.status).toBe(consumer === "avatar" ? 403 : 503);
      expect(denied.response.headers.get("content-type") ?? "").not.toMatch(/^image\//);
      expect(denied.response.headers.get("etag")).toBeNull();
      expect(denied.body.includes(bytes)).toBe(false);
      expect((await request("selected")).response.status).toBe(403);
      const creator = await request("creator");
      expect(creator.response.status, creator.body.toString()).toBe(200);
      expect(creator.body).toEqual(bytes);
    } finally {
      release.resolve();
      await pending;
    }
  },
);
