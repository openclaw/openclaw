import fs from "node:fs/promises";
// Workspace icon tests cover conventional-path resolution, process-stable
// caching, and the authenticated route's scoping, limits, and headers.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
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
import { APNG_BYTES } from "./http-image.test-support.js";
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
  clearWorkspaceIconCacheForTest,
  handleWorkspaceIconHttpRequest,
  resolveWorkspaceIcon,
  SVG_ICON_MAX_BYTES,
  WORKSPACE_ICON_MAX_BYTES,
} = await import("./workspace-icon-http.js");

// 1x1 PNG, a 22-byte ICO header, and a minimal SVG document.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const ICO_BYTES = Buffer.from([
  0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>');

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

beforeEach(() => {
  clearWorkspaceIconCacheForTest();
});

afterEach(() => vi.restoreAllMocks());

describe("resolveWorkspaceIcon", () => {
  const conventions = [
    { relative: "favicon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "favicon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "public/apple-touch-icon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "static/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "ui/public/favicon-32.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "src/app/icon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "assets/logo.png", body: PNG_BYTES, contentType: "image/png" },
  ] as const;

  it.each(conventions)("resolves $relative as $contentType", async (convention) => {
    const root = await makeWorkspace({ [convention.relative]: Buffer.from(convention.body) });
    const icon = await resolveWorkspaceIcon(root);
    expect(icon?.contentType).toBe(convention.contentType);
    expect(icon?.body.equals(convention.body)).toBe(true);
    expect(icon?.etag).toMatch(/^"[\w-]+"$/u);
  });

  it("uses the first valid icon in the fixed precedence", async () => {
    const root = await makeWorkspace({
      "favicon.ico": ICO_BYTES,
      "public/favicon.svg": SVG_BYTES,
      "ui/public/favicon-32.png": PNG_BYTES,
    });
    expect((await resolveWorkspaceIcon(root))?.contentType).toBe("image/x-icon");
  });

  const rejected = [
    { label: "an unconventional location", files: { "vendor/favicon.png": PNG_BYTES } },
    { label: "an empty file", files: { "favicon.ico": Buffer.alloc(0) } },
    { label: "bytes that are not an image", files: { "favicon.ico": Buffer.from("#!/bin/sh\n") } },
    {
      label: "an SVG carrying a doctype",
      files: { "favicon.svg": Buffer.from('<!DOCTYPE svg><svg xmlns="x"></svg>') },
    },
    {
      label: "an SVG referencing an external resource",
      files: {
        "favicon.svg": Buffer.from('<svg xmlns="x"><image href="https://x.test/a.png"/></svg>'),
      },
    },
    {
      label: "an SVG embedding a script element",
      files: { "favicon.svg": Buffer.from('<svg xmlns="x"><script>alert(1)</script></svg>') },
    },
    {
      label: "an SVG past the vector cap",
      files: {
        "favicon.svg": Buffer.concat([
          Buffer.from('<svg xmlns="x"><path d="'),
          Buffer.alloc(SVG_ICON_MAX_BYTES, 0x31),
          Buffer.from('"/></svg>'),
        ]),
      },
    },
    {
      label: "an icon past the size cap",
      files: { "favicon.png": Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1) },
    },
  ] as const;

  it.each(rejected)("records no icon for $label", async ({ files }) => {
    const root = await makeWorkspace({ ...files });
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });

  it("does not follow an icon symlink out of the workspace", async () => {
    const outside = await makeWorkspace({ "secret.png": PNG_BYTES });
    const root = await makeWorkspace({});
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "favicon.png"));
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });

  it("keeps both hits and misses while the root remains cached", async () => {
    const empty = await makeWorkspace({});
    expect(await resolveWorkspaceIcon(empty)).toBeNull();
    await fs.writeFile(path.join(empty, "favicon.png"), PNG_BYTES);
    // An ordinary request does not freshness-poll a resident cache entry.
    expect(await resolveWorkspaceIcon(empty)).toBeNull();

    const filled = await makeWorkspace({ "favicon.png": PNG_BYTES });
    const first = await resolveWorkspaceIcon(filled);
    await fs.rm(path.join(filled, "favicon.png"));
    expect(await resolveWorkspaceIcon(filled)).toBe(first);
  });
});

describe("handleWorkspaceIconHttpRequest", () => {
  let port = 0;
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    projection?.dispose();
    projection = undefined;
    setCurrentPluginMetadataSnapshot(undefined);
    resetPluginRuntimeStateForTest();
    await state?.cleanup();
  });

  beforeEach(() => {
    // The shared test setup retires plugin runtime metadata after every case.
    publishPluginMetadata();
    authorityCurrent = true;
    mocks.authorize
      .mockReset()
      .mockImplementation(({ res }: { res: ServerResponse }) =>
        bindHttpResponseAuthority(
          { authMethod: "token", operatorScopes: ["operator.admin", "operator.read"] },
          res,
          () => authorityCurrent,
        ),
      );
  });

  const iconRoute = (sessionKey: string) =>
    `http://127.0.0.1:${port}/__openclaw__/workspace-icon/${encodeURIComponent(sessionKey)}`;

  it.each([
    { label: "ICO", file: "public/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { label: "APNG", file: "public/favicon.png", body: APNG_BYTES, contentType: "image/png" },
  ])(
    "serves the session workspace $label with sandboxed asset headers",
    async ({ file, body, contentType }) => {
      const root = await makeWorkspace({ [file]: body });
      seedSession(root);

      const response = await fetch(iconRoute("agent:main:one"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-length")).toBe(String(body.byteLength));
      expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="workspace-icon"',
      );
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    },
  );

  it.each([
    {
      name: "exact current tag",
      method: "GET",
      validator: (etag: string) => etag,
      expectedStatus: 304,
    },
    {
      name: "quoted comma/star GET",
      method: "GET",
      validator: '"client,*,tag"',
      expectedStatus: 200,
    },
    {
      name: "weak quoted comma/star HEAD",
      method: "HEAD",
      validator: 'W/"client,*,tag"',
      expectedStatus: 200,
    },
    {
      name: "literal backslash before weak match",
      method: "HEAD",
      validator: (etag: string) => String.raw`"trailing\", W/` + etag,
      expectedStatus: 304,
    },
  ])(
    "honors $name for workspace image responses",
    async ({ method, validator, expectedStatus }) => {
      const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
      seedSession(root);

      const first = await fetch(iconRoute("agent:main:one"));
      const etag = first.headers.get("etag") ?? "";
      expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
      await first.arrayBuffer();

      const response = await fetch(iconRoute("agent:main:one"), {
        method,
        headers: { "If-None-Match": typeof validator === "function" ? validator(etag) : validator },
      });
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="workspace-icon"',
      );
      expect(response.headers.get("content-length")).toBe(
        expectedStatus === 304 ? null : String(PNG_BYTES.byteLength),
      );
      if (expectedStatus === 200) {
        expect(response.headers.get("content-type")).toBe("image/png");
      }
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        expectedStatus === 304 || method === "HEAD" ? Buffer.alloc(0) : PNG_BYTES,
      );
    },
  );

  const absent = [
    { label: "a session with no workspace", hasWorkspace: false },
    { label: "a workspace with no icon", hasWorkspace: true },
  ] as const;

  it.each(absent)("answers an uncacheable 404 for $label", async ({ hasWorkspace }) => {
    seedSession(hasWorkspace ? await makeWorkspace({}) : undefined);
    const response = await fetch(iconRoute("agent:main:one"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves a cold canonical session through its main alias without chat startup", async () => {
    const root = await makeWorkspace({ "public/favicon.ico": ICO_BYTES });
    seedSession(root, "agent:main:main");
    const response = await fetch(iconRoute("main"));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ICO_BYTES);
  });

  it("keeps unavailable session preparation retryable without caching absence", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root);
    const ready = projection;
    projection = undefined;
    try {
      const response = await fetch(iconRoute("agent:main:one"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("1");
      await response.arrayBuffer();
    } finally {
      projection = ready;
    }
    const recovered = await fetch(iconRoute("agent:main:one"));
    expect(recovered.status).toBe(200);
    expect(Buffer.from(await recovered.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("rejects revoked authority while a workspace icon is being prepared", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root, "agent:main:revoked");
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
    try {
      const pending = fetch(iconRoute("agent:main:revoked"));
      await reading.promise;
      authorityCurrent = false;
      release.resolve();

      const response = await pending;
      expect(response.status).toBe(401);
      expect(response.headers.get("etag")).toBeNull();
      expect(await response.json()).toEqual({
        error: { message: "Unauthorized", type: "unauthorized" },
      });
    } finally {
      release.resolve();
      read.mockRestore();
    }
  });

  it("does not publish bytes from a workspace replaced during the read", async () => {
    const original = await makeWorkspace({ "favicon.png": PNG_BYTES });
    const replacement = await makeWorkspace({ "favicon.svg": SVG_BYTES });
    seedSession(original);
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
    const pending = fetch(iconRoute("agent:main:one"));
    try {
      await reading.promise;
      seedSession(replacement, "agent:main:one", { sessionId: "replacement-session" });
      release.resolve();
      const stale = await pending;
      expect(stale.status).toBe(503);
      expect(stale.headers.get("etag")).toBeNull();
      await stale.arrayBuffer();
      const current = await fetch(iconRoute("agent:main:one"));
      expect(current.status).toBe(200);
      expect(Buffer.from(await current.arrayBuffer())).toEqual(SVG_BYTES);
    } finally {
      release.resolve();
      await pending;
      read.mockRestore();
    }
  });

  it("reads a dirty session through workers without synchronous session-store queries", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root);
    const reads = observeHostDataSql();
    try {
      const response = await fetch(iconRoute("agent:main:one"));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
      expect(reads.queries).toEqual([]);
    } finally {
      reads.restore();
    }
  });

  it("never exposes a local decoy for a bound or stopped remote workspace", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root);
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
        const response = await fetch(iconRoute("agent:main:one"));
        expect(response.status).toBe(404);
        expect(response.headers.get("etag")).toBeNull();
        await response.arrayBuffer();
      }
    } finally {
      release();
    }
  });

  it("never reads a local decoy for a repository-owned workspace", async () => {
    const key = "agent:main:repository";
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: "main",
      sessionKey: key,
      url: "https://example.test/project.git",
      assertCurrent: () => {},
    });
    seedSession(await makeWorkspace({ "favicon.png": PNG_BYTES }), key, {
      repositoryWorkspaceId: repository.workspaceId,
    });
    const reads = vi.spyOn(boundaryFileRead, "openRootFile");
    const response = await fetch(iconRoute(key));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reads).not.toHaveBeenCalled();
  });

  it("recovers a missing session after its workspace is published", async () => {
    const key = "agent:main:new-session";
    const missing = await fetch(iconRoute(key));
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    seedSession(await makeWorkspace({ "favicon.png": PNG_BYTES }), key);
    const response = await fetch(iconRoute(key));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("reuses cached bytes and recovers after root-cache eviction", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root);
    const first = await fetch(iconRoute("agent:main:one"));
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(PNG_BYTES);
    await fs.rm(path.join(root, "favicon.png"));
    const cached = await fetch(iconRoute("agent:main:one"));
    expect(cached.status).toBe(200);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(PNG_BYTES);

    for (let index = 0; index < 32; index += 1) {
      await resolveWorkspaceIcon(await makeWorkspace({}));
    }
    await fs.writeFile(path.join(root, "favicon.png"), APNG_BYTES);
    const recovered = await fetch(iconRoute("agent:main:one"));
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(Buffer.from(await recovered.arrayBuffer())).toEqual(APNG_BYTES);
  });

  it.each([
    { label: "exec-node", fields: { execNode: "remote-node" } },
    {
      label: "pending checkout",
      fields: { spawnedCwd: undefined, pendingWorktree: { titleSource: "Pending" } },
    },
  ])("never substitutes local icon bytes for a $label workspace", async ({ fields }) => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root, "agent:main:one", fields);
    const reads = vi.spyOn(boundaryFileRead, "openRootFile");
    const response = await fetch(iconRoute("agent:main:one"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reads).not.toHaveBeenCalled();
  });

  const malformed = ["/__openclaw__/workspace-icon/", "/__openclaw__/workspace-icon/a/b"];

  it.each(malformed)("claims %s as a 404 instead of falling through", async (pathname) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    expect(response.status).toBe(404);
  });

  it("leaves unrelated paths to later stages", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__openclaw__/plugin-icon/x`);
    expect(response.status).toBe(418);
  });

  it("rejects non-read methods", async () => {
    const response = await fetch(iconRoute("agent:main:one"), { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each([401, 403])("never reads a workspace when authorization answers %s", async (status) => {
    seedSession(await makeWorkspace({ "favicon.png": PNG_BYTES }), "agent:main:hidden");
    const reads = vi.spyOn(boundaryFileRead, "openRootFile");
    // `sessions.list` hides incognito and non-owner draft sessions per client.
    // Without that filter here, the read scope alone would let a caller who
    // knows such a key pull bytes derived from a session it cannot list.
    mocks.authorize.mockImplementation(
      async (params: { res: { statusCode: number; end: () => void } }) => {
        params.res.statusCode = status;
        params.res.end();
        return null;
      },
    );
    const response = await fetch(iconRoute("agent:main:hidden"));
    expect(response.status).toBe(status);
    expect(reads).not.toHaveBeenCalled();
  });
});
