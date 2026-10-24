import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { createGatewayHttpServer } from "./server-http.js";
import type { ArtifactTransferHttpCallback } from "./worker-environments/artifact-transfer-http.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http.js";

const activeLimiters: AuthRateLimiter[] = [];
const digest = "a".repeat(64);
const blobDigest = "b".repeat(64);
const transferPath = "/__openclaw__/worker-transfer/v1/environments/worker%3Afixture";
const authorizedFetch = (url: string, bearer: string, method = "GET") =>
  fetch(url, { method, headers: { authorization: `Bearer ${bearer}` } });
const unauthorized = async () => ({ kind: "unauthorized" as const });

afterEach(() => {
  for (const limiter of activeLimiters.splice(0)) {
    limiter.dispose();
  }
});

async function withTransferServer<T>({
  run,
  ...options
}: Partial<Parameters<typeof createGatewayHttpServer>[0]> & {
  run: (origin: string) => Promise<T>;
}): Promise<T> {
  const server = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: true,
    controlUiBasePath: "",
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "none", allowTailscale: false },
    getRuntimeConfig: () => ({}),
    ...options,
  });
  const origin = await listenLoopback(server);
  try {
    return await run(origin);
  } finally {
    await closeHttpServer(server);
  }
}

describe("worker transfer HTTP routing", () => {
  it("reserves the exact bundle namespace and collapses rejected auth", async () => {
    const hooks = vi.fn(async () => false);
    const callback = vi.fn<ArtifactTransferHttpCallback>(unauthorized);
    await withTransferServer({
      handleNodeWorkerBundleTransferRequest: callback,
      handleHooksRequest: hooks,
      run: async (origin) => {
        const url = `${origin}/__openclaw__/worker-bundle/v1/bundles/${digest}`;
        const missing = await fetch(url);
        const rejected = await authorizedFetch(url, "rejected-transfer-token");
        const queried = await authorizedFetch(`${url}?alias=true`, "rejected-transfer-token");
        expect([missing.status, rejected.status, queried.status]).toEqual([404, 404, 404]);
        expect(missing.headers.get("cache-control")).toBe("no-store");
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });
  it("serves only an authorized exact artifact before node enrollment and reserves malformed paths", async () => {
    const hooks = vi.fn(async () => false);
    const callback = vi.fn<ArtifactTransferHttpCallback>(async ({ bearer, artifactKey, res }) =>
      bearer === "bootstrap-capability"
        ? {
            kind: "authorized",
            handle: () => {
              res.end(artifactKey);
            },
          }
        : { kind: "unauthorized" },
    );
    await withTransferServer({
      handleWorkerBootstrapArtifactTransferRequest: callback,
      handleHooksRequest: hooks,
      run: async (origin) => {
        const artifactDigest = "c".repeat(64);
        const url = `${origin}/__openclaw__/worker-bootstrap/artifacts/${artifactDigest}`;
        for (const target of [
          url,
          `${url}?token=bootstrap-capability`,
          `${origin}/__openclaw__/worker-bootstrap/invalid`,
        ]) {
          const response = await fetch(target);
          expect(response.status).toBe(404);
          expect(response.headers.get("cache-control")).toBe("no-store");
        }
        const response = await authorizedFetch(url, "bootstrap-capability");
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe(artifactDigest);
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });
});

describe("node workspace transfer HTTP routing", () => {
  it("reserves the namespace before hooks and collapses missing or rejected auth", async () => {
    const hooks = vi.fn(async () => false);
    const callback = vi.fn<NodeWorkspaceTransferHttpCallback>(unauthorized);
    await withTransferServer({
      handleNodeWorkspaceTransferRequest: callback,
      handleHooksRequest: hooks,
      run: async (origin) => {
        const url = `${origin}${transferPath}/snapshots/${digest}/pack`;
        const missing = await fetch(url);
        const rejected = await authorizedFetch(url, "rejected-transfer-token");
        for (const response of [missing, rejected]) {
          expect(response.status).toBe(404);
          expect(response.headers.get("cache-control")).toBe("no-store");
          await expect(response.json()).resolves.toEqual({ error: "not_found" });
        }
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });

  it("parses the closed route family and lets authenticated work own its response", async () => {
    const routes: Array<{ kind: string; environmentId: string }> = [];
    const callback: NodeWorkspaceTransferHttpCallback = async ({ bearer, res, route }) => {
      if (bearer !== "valid-transfer-token") {
        return { kind: "unauthorized" };
      }
      routes.push(route);
      return {
        kind: "authorized",
        handle: () => {
          const reconcile = route.kind === "reconcile";
          res.statusCode = reconcile ? 413 : 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify(
              reconcile ? { error: "workspace_transfer_limit" } : { kind: route.kind },
            ),
          );
        },
      };
    };
    await withTransferServer({
      handleNodeWorkspaceTransferRequest: callback,
      run: async (origin) => {
        const request = (path: string, method = "GET") =>
          authorizedFetch(`${origin}${transferPath}/${path}`, "valid-transfer-token", method);
        const manifest = await request(`snapshots/${digest}/manifest`);
        const pack = await request(`snapshots/${digest}/pack`);
        const blob = await request(`blobs/${blobDigest}`);
        const reconcile = await request(`reconciliations/${digest}`, "POST");
        expect([manifest.status, pack.status, blob.status, reconcile.status]).toEqual([
          200, 200, 200, 413,
        ]);
        expect(pack.headers.get("cache-control")).toBe("no-store");
        expect(reconcile.headers.get("cache-control")).toBe("no-store");
        await expect(reconcile.json()).resolves.toEqual({ error: "workspace_transfer_limit" });
        const download = { direction: "download", environmentId: "worker:fixture" };
        expect(routes).toEqual([
          { ...download, kind: "manifest", manifestRef: `sha256:${digest}` },
          { ...download, kind: "pack", manifestRef: `sha256:${digest}` },
          { ...download, kind: "blob", sha256: blobDigest },
          {
            kind: "reconcile",
            direction: "upload",
            environmentId: "worker:fixture",
            baseManifestRef: `sha256:${digest}`,
          },
        ]);
      },
    });
  });

  it("rate-limits invalid transfer auth before invoking the callback again", async () => {
    const limiter = createGatewayAuthRateLimiter(
      { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
      { scheduler: createTestGatewayScheduler() },
    );
    activeLimiters.push(limiter);
    const callback = vi.fn<NodeWorkspaceTransferHttpCallback>(unauthorized);
    await withTransferServer({
      handleNodeWorkspaceTransferRequest: callback,
      joinRateLimiter: limiter,
      run: async (origin) => {
        const url = `${origin}${transferPath}/snapshots/${digest}/pack`;
        const rejected = await authorizedFetch(url, "rejected-transfer-token");
        const limited = await authorizedFetch(url, "another-transfer-token");
        expect([rejected.status, limited.status]).toEqual([404, 429]);
        expect(limited.headers.get("cache-control")).toBe("no-store");
        expect(limited.headers.get("retry-after")).toBe("60");
        await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
        expect(callback).toHaveBeenCalledOnce();
      },
    });
  });
});
