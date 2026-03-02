import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { canonicalizePathVariant, isProtectedPluginRoutePath } from "./security-path.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  buildChannelPathFuzzCorpus,
  CANONICAL_AUTH_VARIANTS,
  CANONICAL_UNAUTH_VARIANTS,
  createCanonicalizedChannelPluginHandler,
  createHooksHandler,
  createTestGatewayServer,
  expectAuthorizedVariants,
  expectUnauthorizedResponse,
  expectUnauthorizedVariants,
  sendRequest,
  withGatewayServer,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";

function canonicalizePluginPath(pathname: string): string {
  return canonicalizePathVariant(pathname);
}

describe("gateway plugin HTTP auth boundary", () => {
  test("applies default security headers and optional strict transport security", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-security-headers-test-", async () => {
      const withoutHsts = createTestGatewayServer({ resolvedAuth: AUTH_NONE });
      const withoutHstsResponse = await sendRequest(withoutHsts, { path: "/missing" });
      expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith(
        "X-Content-Type-Options",
        "nosniff",
      );
      expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
      expect(withoutHstsResponse.setHeader).not.toHaveBeenCalledWith(
        "Strict-Transport-Security",
        expect.any(String),
      );

      const withHsts = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          strictTransportSecurityHeader: "max-age=31536000; includeSubDomains",
        },
      });
      const withHstsResponse = await sendRequest(withHsts, { path: "/missing" });
      expect(withHstsResponse.setHeader).toHaveBeenCalledWith(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    });
  });

  test("serves unauthenticated liveness/readiness probe routes when no other route handles them", async () => {
    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-test-",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        const probeCases = [
          { path: "/health", status: "live" },
          { path: "/healthz", status: "live" },
          { path: "/ready", status: "ready" },
          { path: "/readyz", status: "ready" },
        ] as const;

        for (const probeCase of probeCases) {
          const response = await sendRequest(server, { path: probeCase.path });
          expect(response.res.statusCode, probeCase.path).toBe(200);
          expect(response.getBody(), probeCase.path).toBe(
            JSON.stringify({ ok: true, status: probeCase.status }),
          );
        }
      },
    });
  });

  test("does not shadow plugin routes mounted on probe paths", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/healthz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "plugin-health" }));
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-shadow-test-",
      resolvedAuth: AUTH_NONE,
      overrides: { handlePluginRequest },
      run: async (server) => {
        const response = await sendRequest(server, { path: "/healthz" });
        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe(JSON.stringify({ ok: true, route: "plugin-health" }));
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("rejects non-GET/HEAD methods on probe routes", async () => {
    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-method-test-",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const postResponse = await sendRequest(server, { path: "/healthz", method: "POST" });
        expect(postResponse.res.statusCode).toBe(405);
        expect(postResponse.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
        expect(postResponse.getBody()).toBe("Method Not Allowed");

        const headResponse = await sendRequest(server, { path: "/readyz", method: "HEAD" });
        expect(headResponse.res.statusCode).toBe(200);
        expect(headResponse.getBody()).toBe("");
      },
    });
  });

  test("requires gateway auth for protected plugin route space and allows authenticated pass-through", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/channels") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "channel-root" }));
        return true;
      }
      if (pathname === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "channel" }));
        return true;
      }
      if (pathname === "/plugin/public") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "public" }));
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          isProtectedPluginRoutePath(pathContext.pathname) ||
          pathContext.pathname === "/plugin/public",
      },
      run: async (server) => {
        const unauthenticated = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expectUnauthorizedResponse(unauthenticated);
        expect(handlePluginRequest).not.toHaveBeenCalled();

        const unauthenticatedRoot = await sendRequest(server, { path: "/api/channels" });
        expectUnauthorizedResponse(unauthenticatedRoot);
        expect(handlePluginRequest).not.toHaveBeenCalled();

        const authenticated = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"route":"channel"');

        const unauthenticatedPublic = await sendRequest(server, { path: "/plugin/public" });
        expectUnauthorizedResponse(unauthenticatedPublic);

        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("keeps wildcard plugin handlers ungated when auth enforcement predicate excludes their paths", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/plugin/routed") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "routed" }));
        return true;
      }
      if (pathname === "/googlechat") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "wildcard-handler" }));
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-wildcard-handler-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname.startsWith("/api/channels") ||
          pathContext.pathname === "/plugin/routed",
      },
      run: async (server) => {
        const unauthenticatedRouted = await sendRequest(server, { path: "/plugin/routed" });
        expectUnauthorizedResponse(unauthenticatedRouted);

        const unauthenticatedWildcard = await sendRequest(server, { path: "/googlechat" });
        expect(unauthenticatedWildcard.res.statusCode).toBe(200);
        expect(unauthenticatedWildcard.getBody()).toContain('"route":"wildcard-handler"');

        const authenticatedRouted = await sendRequest(server, {
          path: "/plugin/routed",
          authorization: "Bearer test-token",
        });
        expect(authenticatedRouted.res.statusCode).toBe(200);
        expect(authenticatedRouted.getBody()).toContain('"route":"routed"');
      },
    });
  });

  test("uses /api/channels auth by default while keeping wildcard handlers ungated with no predicate", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (canonicalizePluginPath(pathname) === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "channel-default" }));
        return true;
      }
      if (pathname === "/googlechat") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "wildcard-default" }));
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-wildcard-default-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handlePluginRequest },
      run: async (server) => {
        const unauthenticated = await sendRequest(server, { path: "/googlechat" });
        expect(unauthenticated.res.statusCode).toBe(200);
        expect(unauthenticated.getBody()).toContain('"route":"wildcard-default"');

        const unauthenticatedChannel = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expectUnauthorizedResponse(unauthenticatedChannel);

        const unauthenticatedDeepEncodedChannel = await sendRequest(server, {
          path: "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
        });
        expectUnauthorizedResponse(unauthenticatedDeepEncodedChannel);

        const authenticated = await sendRequest(server, {
          path: "/googlechat",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"route":"wildcard-default"');

        const authenticatedChannel = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          authorization: "Bearer test-token",
        });
        expect(authenticatedChannel.res.statusCode).toBe(200);
        expect(authenticatedChannel.getBody()).toContain('"route":"channel-default"');

        const authenticatedDeepEncodedChannel = await sendRequest(server, {
          path: "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
          authorization: "Bearer test-token",
        });
        expect(authenticatedDeepEncodedChannel.res.statusCode).toBe(200);
        expect(authenticatedDeepEncodedChannel.getBody()).toContain('"route":"channel-default"');
      },
    });
  });

  test("serves plugin routes before control ui spa fallback", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/plugins/diffs/view/demo-id/demo-token") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<!doctype html><title>diff-view</title>");
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-control-ui-precedence-test-",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "missing" },
        handlePluginRequest,
      },
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/diffs/view/demo-id/demo-token",
        });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toContain("diff-view");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("passes POST webhook routes through root-mounted control ui to plugins", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method !== "POST" || pathname !== "/bluebubbles-webhook") {
        return false;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("plugin-webhook");
      return true;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-control-ui-webhook-post-test-",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "missing" },
        handlePluginRequest,
      },
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/bluebubbles-webhook",
          method: "POST",
        });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("plugin-webhook");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("does not let plugin handlers shadow control ui routes", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/chat") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("plugin-shadow");
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-control-ui-shadow-test-",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "missing" },
        handlePluginRequest,
      },
      run: async (server) => {
        const response = await sendRequest(server, { path: "/chat" });

        expect(response.res.statusCode).toBe(503);
        expect(response.getBody()).toContain("Control UI assets not found");
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("requires gateway auth for canonicalized /api/channels variants", async () => {
    const handlePluginRequest = createCanonicalizedChannelPluginHandler();

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-canonicalized-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          isProtectedPluginRoutePath(pathContext.pathname),
      },
      run: async (server) => {
        await expectUnauthorizedVariants({ server, variants: CANONICAL_UNAUTH_VARIANTS });
        expect(handlePluginRequest).not.toHaveBeenCalled();

        await expectAuthorizedVariants({
          server,
          variants: CANONICAL_AUTH_VARIANTS,
          authorization: "Bearer test-token",
        });
        expect(handlePluginRequest).toHaveBeenCalledTimes(CANONICAL_AUTH_VARIANTS.length);
      },
    });
  });

  test("rejects unauthenticated plugin-channel fuzz corpus variants", async () => {
    const handlePluginRequest = createCanonicalizedChannelPluginHandler();

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-fuzz-corpus-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          isProtectedPluginRoutePath(pathContext.pathname),
      },
      run: async (server) => {
        for (const variant of buildChannelPathFuzzCorpus()) {
          const response = await sendRequest(server, { path: variant.path });
          expect(response.res.statusCode, variant.label).toBe(401);
          expect(response.getBody(), variant.label).toContain("Unauthorized");
        }
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("enforces auth before plugin handlers on encoded protected-path variants", async () => {
    const encodedVariants = buildChannelPathFuzzCorpus().filter((variant) =>
      variant.path.includes("%"),
    );
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, route: "should-not-run" }));
      return true;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-encoded-order-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handlePluginRequest },
      run: async (server) => {
        for (const variant of encodedVariants) {
          const response = await sendRequest(server, { path: variant.path });
          expect(response.res.statusCode, variant.label).toBe(401);
          expect(response.getBody(), variant.label).toContain("Unauthorized");
        }
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test.each(["0.0.0.0", "::"])(
    "returns 404 (not 500) for non-hook routes with hooks enabled and bindHost=%s",
    async (bindHost) => {
      await withGatewayTempConfig("openclaw-plugin-http-hooks-bindhost-", async () => {
        const handleHooksRequest = createHooksHandler(bindHost);
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: { handleHooksRequest },
        });

        const response = await sendRequest(server, { path: "/" });

        expect(response.res.statusCode).toBe(404);
        expect(response.getBody()).toBe("Not Found");
      });
    },
  );

  test("rejects query-token hooks requests with bindHost=::", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-hooks-query-token-", async () => {
      const handleHooksRequest = createHooksHandler("::");
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: { handleHooksRequest },
      });

      const response = await sendRequest(server, { path: "/hooks/wake?token=bad" });

      expect(response.res.statusCode).toBe(400);
      expect(response.getBody()).toContain("Hook token must be provided");
    });
  });
});
