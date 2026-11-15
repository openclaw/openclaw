import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  authorizeControlUiSessionOwnerReadRequestOrReply: (...args: unknown[]) =>
    mocks.authorize(...args),
}));

const {
  handleWorkspaceIconHttpRequest,
  resolveWorkspaceIcon,
  SVG_ICON_MAX_BYTES,
  WORKSPACE_ICON_MAX_BYTES,
} = await import("./workspace-icon-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const ICO_BYTES = Buffer.from([
  0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>');

function expectHeaders(response: Response, headers: Record<string, string | null>) {
  for (const [name, value] of Object.entries(headers)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

function holdIconRead() {
  const reading = createDeferredCore();
  const release = createDeferredCore();
  const readFile = boundaryFileRead.readFileDescriptorBounded;
  const read = vi
    .spyOn(boundaryFileRead, "readFileDescriptorBounded")
    .mockImplementationOnce(async (...args) => {
      reading.resolve();
      await release.promise;
      return await readFile(...args);
    });
  return { reading: reading.promise, release: release.resolve, restore: () => read.mockRestore() };
}

const roots = useAutoCleanupTempDirTracker(afterEach);

async function makeWorkspace(files: Record<string, Buffer>): Promise<string> {
  // Canonicalize first: macOS tmp is a /var -> /private/var symlink and the
  // resolver returns realpaths, so a raw mkdtemp root would not compare equal.
  const root = await fs.realpath(roots.make("openclaw-ws-icon-"));
  for (const [relative, body] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
  }
  return root;
}

afterEach(() => vi.restoreAllMocks());

describe("resolveWorkspaceIcon", () => {
  const rejected = [
    ["an empty file", "ico", Buffer.alloc(0)],
    ["bytes that are not an image", "ico", Buffer.from("#!/bin/sh\n")],
    ["an SVG carrying a doctype", "svg", '<!DOCTYPE svg><svg xmlns="x"></svg>'],
    ["external SVG", "svg", '<svg xmlns="x"><image href="https://x.test"/></svg>'],
    ["an SVG script", "svg", '<svg xmlns="x"><script>alert(1)</script></svg>'],
    ["oversized SVG", "svg", `<svg xmlns="x">${"1".repeat(SVG_ICON_MAX_BYTES)}</svg>`],
    ["an icon past the size cap", "png", Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1)],
  ] as const;

  it.each(rejected)("records no icon for %s", async (_label, extension, body) => {
    const root = await makeWorkspace({
      [`favicon.${extension}`]: typeof body === "string" ? Buffer.from(body) : body,
    });
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });

  it("does not follow an icon symlink out of the workspace", async () => {
    const outside = await makeWorkspace({ "secret.png": PNG_BYTES });
    const root = await makeWorkspace({});
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "favicon.png"));
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });
});

describe("handleWorkspaceIconHttpRequest", () => {
  let origin: string;
  let server: ReturnType<typeof createServer>;
  let authorityCurrent = true;
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  let projection: SessionRowProjection | undefined;
  const context = bindSessionRowProjection({}, () => projection);

  function seedSession(
    root?: string,
    key = "agent:main:one",
    fields: Partial<InternalSessionEntry> = {},
  ) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: key,
        updatedAt: 1,
        ...(root ? { spawnedCwd: root } : { pendingWorktree: { titleSource: "Pending" } }),
        ...fields,
      },
    );
  }

  function publishPluginMetadata() {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(), {
      config: cfg,
      compatibleConfigs: [cfg],
    });
  }

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    cfg = {
      agents: {
        entries: { main: {} },
        defaults: { workspace: state.workspaceDir },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    publishPluginMetadata();
    // Gateway startup admits the physical store before serving prepared reads.
    seedSession(undefined, "agent:main:fixture");
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    server = createServer((req, res) => {
      void handleWorkspaceIconHttpRequest(req, res, {
        ...context,
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      })
        .then((handled) => {
          if (!handled) {
            res.statusCode = 418;
            res.end("unhandled");
          }
        })
        .catch(() => finishFailedGatewayHttpResponse(res));
    });
    origin = await listenLoopback(server);
  });

  afterAll(async () => {
    await closeHttpServer(server);
    projection?.dispose();
    projection = undefined;
    setCurrentPluginMetadataSnapshot(undefined);
    resetPluginRuntimeStateForTest();
    await state?.cleanup();
  });

  let sessionVisible = true;

  beforeEach(() => {
    // The shared test setup retires plugin runtime metadata after every case.
    publishPluginMetadata();
    authorityCurrent = true;
    sessionVisible = true;
    mocks.authorize.mockReset().mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority(
        {
          authMethod: "token",
          operatorScopes: ["operator.admin", "operator.read"],
          canReadSession: () => sessionVisible,
        },
        res,
        () => authorityCurrent,
      ),
    );
  });

  const iconRoute = (sessionKey: string) =>
    `${origin}/__openclaw__/workspace-icon/${encodeURIComponent(sessionKey)}`;
  async function requestIcon(status = 200, key = "agent:main:one") {
    const response = await fetch(iconRoute(key));
    expect(response.status).toBe(status);
    return response;
  }
  async function seedIcon(key = "agent:main:one", fields: Partial<InternalSessionEntry> = {}) {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root, key, fields);
    return root;
  }
  async function expectBody(response: Response, bytes: Buffer) {
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }

  it.each([
    {
      name: "weak quoted comma/star HEAD",
      validator: 'W/"client,*,tag"',
      expectedStatus: 200,
    },
    {
      name: "literal backslash before weak match",
      validator: (etag: string) => String.raw`"trailing\", W/` + etag,
      expectedStatus: 304,
    },
  ])("honors $name for workspace image responses", async ({ validator, expectedStatus }) => {
    await seedIcon();

    const first = await fetch(iconRoute("agent:main:one"));
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    await first.arrayBuffer();

    const response = await fetch(iconRoute("agent:main:one"), {
      method: "HEAD",
      headers: { "If-None-Match": typeof validator === "function" ? validator(etag) : validator },
    });
    expect(response.status).toBe(expectedStatus);
    expectHeaders(response, {
      etag,
      "content-disposition": 'attachment; filename="workspace-icon"',
      "content-length": expectedStatus === 304 ? null : String(PNG_BYTES.byteLength),
    });
    if (expectedStatus === 200) {
      expect(response.headers.get("content-type")).toBe("image/png");
    }
    await expectBody(response, Buffer.alloc(0));
  });

  it("refuses a session the profile cannot see without reading its workspace", async () => {
    await seedIcon();
    sessionVisible = false;
    const read = vi.spyOn(boundaryFileRead, "readFileDescriptorBounded");
    try {
      const response = await requestIcon(403);
      expectHeaders(response, { "cache-control": "no-store" });
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { message: "session access required", type: "forbidden" },
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    sessionVisible = true;
    await expectBody(await requestIcon(), PNG_BYTES);
  });

  it("briefly caches an authenticated 404 for a workspace with no icon", async () => {
    seedSession(await makeWorkspace({}));
    const response = await requestIcon(404);
    expectHeaders(response, {
      "cache-control": "private, max-age=60",
      vary: "Authorization, Cookie",
    });
  });

  it("serves a cold canonical session through its main alias without chat startup", async () => {
    const root = await makeWorkspace({ "public/favicon.ico": ICO_BYTES });
    seedSession(root, "agent:main:main");
    const response = await requestIcon(200, "main");
    expectHeaders(response, {
      "content-type": "image/x-icon",
      "content-length": String(ICO_BYTES.byteLength),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": 'attachment; filename="workspace-icon"',
    });
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await expectBody(response, ICO_BYTES);
  });

  it.each(["authority", "workspace"])(
    "rejects a changed %s during icon preparation",
    async (kind) => {
      await seedIcon();
      const replacement =
        kind === "workspace" ? await makeWorkspace({ "favicon.svg": SVG_BYTES }) : undefined;
      const held = holdIconRead();
      const pending = fetch(iconRoute("agent:main:one"));
      try {
        await held.reading;
        if (replacement) {
          seedSession(replacement, "agent:main:one", { sessionId: "replacement-session" });
        } else {
          authorityCurrent = false;
        }
        held.release();
        const response = await pending;
        expect(response.status).toBe(kind === "authority" ? 401 : 503);
        expectHeaders(response, { etag: null });
        if (kind === "authority") {
          expect(await response.json()).toEqual({
            error: { message: "Unauthorized", type: "unauthorized" },
          });
        } else {
          await response.arrayBuffer();
          await expectBody(await requestIcon(), SVG_BYTES);
        }
      } finally {
        held.release();
        await pending;
        held.restore();
      }
    },
  );

  it("never exposes a local decoy for a bound or stopped remote workspace", async () => {
    const root = await seedIcon();
    const release = registerAgentWorkspaceAccess(root, {
      bridge: {
        readFile: async () => {
          throw new Error("unexpected remote icon read");
        },
        writeFile: async () => {
          throw new Error("unexpected write");
        },
        stat: async () => null,
      },
    });
    try {
      for (const stopped of [false, true]) {
        if (stopped) {
          release();
        }
        const response = await requestIcon(404);
        expect(response.headers.get("etag")).toBeNull();
        await response.arrayBuffer();
      }
    } finally {
      release();
    }
  });

  it.each(["missing session", "unavailable projection"])(
    "recovers a %s without caching absence",
    async (kind) => {
      const key = kind === "missing session" ? "agent:main:new-session" : "agent:main:one";
      const ready = projection;
      if (kind === "unavailable projection") {
        await seedIcon(key);
        projection = undefined;
      }
      try {
        const response = await requestIcon(kind === "missing session" ? 404 : 503, key);
        if (kind === "unavailable projection") {
          expectHeaders(response, { "cache-control": "no-store", "retry-after": "1" });
        }
        await response.arrayBuffer();
      } finally {
        projection = ready;
      }
      if (kind === "missing session") {
        await seedIcon(key);
      }
      await expectBody(await requestIcon(200, key), PNG_BYTES);
    },
  );

  it.each(["exec-node", "pending checkout", "repository-owned"])(
    "never reads a local decoy for a %s workspace",
    async (kind) => {
      const key = "agent:main:one";
      let fields: Partial<InternalSessionEntry>;
      if (kind === "repository-owned") {
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey: key,
          url: "https://example.test/project.git",
          assertCurrent: () => {},
        });
        fields = { repositoryWorkspaceId: repository.workspaceId };
      } else {
        fields =
          kind === "exec-node"
            ? { execNode: "remote-node" }
            : { spawnedCwd: undefined, pendingWorktree: { titleSource: "Pending" } };
      }
      await seedIcon(key, fields);
      const reads = vi.spyOn(boundaryFileRead, "openRootFile");
      const response = await requestIcon(404, key);
      expectHeaders(response, { "cache-control": "no-store" });
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/__openclaw__/workspace-icon/", "GET", 404, null],
    ["/__openclaw__/plugin-icon/x", "GET", 418, null],
    ["/__openclaw__/workspace-icon/agent:main:one", "POST", 405, "GET, HEAD"],
  ] as const)("routes %s %s", async (pathname, method, status, allow) => {
    const response = await fetch(`${origin}${pathname}`, { method });
    expect(response.status).toBe(status);
    if (allow) {
      expectHeaders(response, { allow });
    }
  });

  it("never reads a workspace when authorization answers 401", async () => {
    await seedIcon("agent:main:hidden");
    const reads = vi.spyOn(boundaryFileRead, "openRootFile");
    // `sessions.list` hides incognito and non-owner draft sessions per client.
    // Without that filter here, the read scope alone would let a caller who
    // knows such a key pull bytes derived from a session it cannot list.
    mocks.authorize.mockImplementation(
      async (params: { res: { statusCode: number; end: () => void } }) => {
        params.res.statusCode = 401;
        params.res.end();
        return null;
      },
    );
    await requestIcon(401, "agent:main:hidden");
    expect(reads).not.toHaveBeenCalled();
  });
});
