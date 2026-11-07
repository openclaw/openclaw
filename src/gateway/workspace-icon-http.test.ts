import nativeFs from "node:fs";
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
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import * as workerCpu from "../infra/worker-cpu.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const authorize = vi.hoisted(() => vi.fn());

// mock-isolation: Credential admission stays isolated; cases bind live response authority explicitly.
vi.mock("./http-utils.js", () => ({
  authorizeControlUiSessionOwnerReadRequestOrReply: authorize,
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
function holdIconRead(root: string) {
  const reading = createDeferredCore();
  const release = createDeferredCore();
  // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the intercepted pool receiver.
  const run = WorkerTaskPool.prototype.run;
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async function (
    this: WorkerTaskPool<unknown, unknown>,
    ...args
  ) {
    if (args[0] === root) {
      reading.resolve();
      await release.promise;
    }
    return await run.apply(this, args);
  });
  return { reading: reading.promise, release: release.resolve };
}
const roots = useAutoCleanupTempDirTracker(afterEach);
async function makeWorkspace(files: Record<string, Buffer | string>): Promise<string> {
  // Match fs-safe's canonical spelling, including macOS /var -> /private/var.
  const root = await fs.realpath(roots.make("openclaw-ws-icon-"));
  for (const [relative, body] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
  }
  return root;
}
afterEach(() => vi.restoreAllMocks());

describe("handleWorkspaceIconHttpRequest", () => {
  let origin: string;
  let server: ReturnType<typeof createServer>;
  let authorityCurrent = true;
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  const cfg: OpenClawConfig = {};
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
    cfg.agents = {
      entries: { main: {} },
      defaults: { workspace: state.workspaceDir },
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
    resetPluginRuntimeStateForTest();
    await state?.cleanup();
  });

  let sessionVisible = true;

  beforeEach(() => {
    // The shared test setup retires plugin runtime metadata after every case.
    publishPluginMetadata();
    authorityCurrent = true;
    sessionVisible = true;
    authorize
      .mockReset()
      .mockImplementation(({ res }: { res: ServerResponse }) =>
        bindHttpResponseAuthority(
          { canReadSession: () => sessionVisible },
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

  it("serves a cold canonical session through the packaged worker while HTTP progresses", async (test) => {
    const root = await makeWorkspace({ "public/favicon.ico": ICO_BYTES });
    seedSession(root, "agent:main:main");
    // Native blocking probe: run on Testbox/CI, never the production Gateway host.
    const progress = new Int32Array(new SharedArrayBuffer(12));
    const lstat = nativeFs.lstatSync;
    const delay = (...args: Parameters<typeof nativeFs.lstatSync>) => {
      if (String(args[0]).startsWith(root) && Atomics.compareExchange(progress, 0, 0, 1) === 0) {
        Atomics.wait(progress, 2, 0, 250);
        Atomics.store(progress, 0, 2);
      }
      return lstat(...args);
    };
    vi.spyOn(nativeFs, "lstatSync").mockImplementation(delay);
    const create = workerCpu.createCpuTrackedWorker;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((entry, options, classify) =>
      create(
        String(entry).includes("workspace-icon.worker")
          ? new URL(
              "data:text/javascript," +
                encodeURIComponent(`
              import fs from "node:fs";
              import { workerData } from "node:worker_threads";
              const root = ${JSON.stringify(root)}, progress = new Int32Array(workerData.iconProgress);
              const lstat = fs.lstatSync;
              fs.lstatSync = ${delay.toString()};
              await import(${JSON.stringify(new URL(`../../dist/${runtimeProcessEntrypoints.workspaceIcon.distWorkerPath}`, import.meta.url).href)});
            `),
            )
          : entry,
        {
          ...options,
          execArgv: String(entry).includes("workspace-icon.worker") ? [] : options?.execArgv,
          workerData: { ...options?.workerData, iconProgress: progress.buffer },
        },
        classify,
      ),
    );
    const heartbeat = setInterval(() => {
      if (Atomics.load(progress, 0) === 1) {
        Atomics.add(progress, 1, 1);
      }
    }, 1);
    test.onTestFinished(() => clearInterval(heartbeat));
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
    expect(Atomics.load(progress, 0)).toBe(2);
    expect(Atomics.load(progress, 1)).toBeGreaterThan(1);
  });

  it.each([
    ["weak quoted comma/star HEAD", 'W/"client,*,tag"', 200],
    [
      "literal backslash before weak match",
      (etag: string) => String.raw`"trailing\", W/` + etag,
      304,
    ],
  ] as const)(
    "honors %s for workspace image responses",
    async (_name, validator, expectedStatus) => {
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
        "content-type": expectedStatus === 304 ? null : "image/png",
      });
      await expectBody(response, Buffer.alloc(0));
    },
  );

  it.each([401, 403])("refuses %i without reading a hidden workspace", async (status) => {
    await seedIcon("agent:main:hidden");
    sessionVisible = false;
    if (status === 401) {
      authorize.mockImplementation(({ res }: { res: ServerResponse }) => {
        res.statusCode = 401;
        res.end();
        return null;
      });
    }
    const reads = vi.spyOn(WorkerTaskPool.prototype, "run");
    const response = await requestIcon(status, "agent:main:hidden");
    expect(reads.mock.calls.some(([input]) => typeof input === "string")).toBe(false);
    if (status === 403) {
      expectHeaders(response, { "cache-control": "no-store" });
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { message: "session access required", type: "forbidden" },
      });
      sessionVisible = true;
      await expectBody(await requestIcon(200, "agent:main:hidden"), PNG_BYTES);
    }
  });

  it.each(["authority", "workspace"])(
    "rejects a changed %s during icon preparation",
    async (kind) => {
      const root = await seedIcon();
      const replacement =
        kind === "workspace" ? await makeWorkspace({ "favicon.svg": SVG_BYTES }) : undefined;
      const held = holdIconRead(root);
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
      }
    },
  );

  it.each([
    [
      "empty workspace",
      404,
      { "cache-control": "private, max-age=60", vary: "Authorization, Cookie" },
    ],
    ["missing session", 404, {}],
    ["unavailable projection", 503, { "cache-control": "no-store", "retry-after": "1" }],
  ] as const)("handles and recovers %s", async (kind, status, headers) => {
    const key = kind === "missing session" ? "agent:main:new-session" : "agent:main:one";
    const root = await makeWorkspace(
      kind === "empty workspace" ? {} : { "favicon.png": PNG_BYTES },
    );
    if (kind !== "missing session") {
      seedSession(root, key);
    }
    const ready = projection;
    if (kind === "unavailable projection") {
      projection = undefined;
    }
    try {
      const response = await requestIcon(status, key);
      expectHeaders(response, headers);
      await response.arrayBuffer();
    } finally {
      projection = ready;
    }
    if (kind === "empty workspace") {
      return;
    }
    if (kind === "missing session") {
      seedSession(root, key);
    }
    await expectBody(await requestIcon(200, key), PNG_BYTES);
  });

  it.each(["bound", "stopped", "exec-node", "pending checkout", "repository-owned"])(
    "never reads a local decoy for a %s workspace",
    async (kind) => {
      const key = "agent:main:one";
      let fields: Partial<InternalSessionEntry> = {};
      if (kind === "repository-owned") {
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey: key,
          url: "https://example.test/project.git",
          assertCurrent: () => {},
        });
        fields.repositoryWorkspaceId = repository.workspaceId;
      } else if (kind === "exec-node") {
        fields.execNode = "remote-node";
      } else if (kind === "pending checkout") {
        fields = { spawnedCwd: undefined, pendingWorktree: { titleSource: "Pending" } };
      }
      const root = await seedIcon(key, fields);
      const unexpected = vi.fn().mockRejectedValue(new Error("unexpected workspace I/O"));
      const release =
        kind === "bound" || kind === "stopped"
          ? registerAgentWorkspaceAccess(root, {
              bridge: { readFile: unexpected, writeFile: unexpected, stat: async () => null },
            })
          : () => {};
      if (kind === "stopped") {
        release();
      }
      try {
        const reads = vi.spyOn(WorkerTaskPool.prototype, "run");
        const response = await requestIcon(404, key);
        expectHeaders(response, { "cache-control": "no-store", etag: null });
        await response.arrayBuffer();
        expect(reads.mock.calls.some(([input]) => typeof input === "string")).toBe(false);
        expect(unexpected).not.toHaveBeenCalled();
      } finally {
        release();
      }
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
});

describe("resolveWorkspaceIcon", () => {
  it.each([
    ["an empty file", "ico", Buffer.alloc(0)],
    ["bytes that are not an image", "ico", Buffer.from("#!/bin/sh\n")],
    ["an SVG carrying a doctype", "svg", '<!DOCTYPE svg><svg xmlns="x"></svg>'],
    ["external SVG", "svg", '<svg xmlns="x"><image href="https://x.test"/></svg>'],
    ["an SVG script", "svg", '<svg xmlns="x"><script>alert(1)</script></svg>'],
    ["oversized SVG", "svg", `<svg xmlns="x">${"1".repeat(SVG_ICON_MAX_BYTES)}</svg>`],
    ["an icon past the size cap", "png", Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1)],
    ["an out-of-root symlink", "png", null],
  ] as const)("records no icon for %s", async (_label, extension, body) => {
    const root = await makeWorkspace(body === null ? {} : { [`favicon.${extension}`]: body });
    if (body === null) {
      const outside = await makeWorkspace({ "secret.png": PNG_BYTES });
      await fs.symlink(path.join(outside, "secret.png"), path.join(root, "favicon.png"));
    }
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });
});
