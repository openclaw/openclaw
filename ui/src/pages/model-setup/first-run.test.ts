import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { routeIdFromPath } from "../../app-routes.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { consumeCachedModelSetupDetection } from "./detect-cache.ts";
import {
  isDefaultChatLanding,
  locationsMatchDefaultLanding,
  startModelSetupFirstRunRedirect,
} from "./first-run.ts";

describe("model setup first-run redirect", () => {
  it("recognizes only the implicit chat landing without a session deep link", () => {
    expect(isDefaultChatLanding({ pathname: "/", search: "", hash: "" }, "", routeIdFromPath)).toBe(
      true,
    );
    expect(
      isDefaultChatLanding({ pathname: "/chat", search: "", hash: "" }, "", routeIdFromPath),
    ).toBe(true);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "?session=main", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "", hash: "#session=main" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/settings/general", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
  });

  it("keeps the canonical main session on the default landing", () => {
    const hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "dev",
          mainKey: "main",
          mainSessionKey: "agent:dev:main",
        },
      },
    } as GatewayHelloOk;
    const expected = { pathname: "/chat", search: "?session=main", hash: "" };

    expect(
      locationsMatchDefaultLanding(
        { pathname: "/chat", search: "?session=agent%3Adev%3Amain", hash: "" },
        expected,
        hello,
      ),
    ).toBe(true);
    expect(
      locationsMatchDefaultLanding(
        { pathname: "/chat", search: "?session=agent%3Adev%3Aother", hash: "" },
        expected,
        hello,
      ),
    ).toBe(false);
  });

  it("detects once, caches the result, and redirects once", async () => {
    const result = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    };
    const request = vi.fn().mockResolvedValue(result);
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const snapshot = {
      connected: true,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    };
    const replace = vi.fn();
    const context = {
      gateway: {
        snapshot,
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      replace,
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => true });
    expect(listener).not.toBeNull();
    listener!(snapshot as Parameters<GatewayListener>[0]);
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.detect",
      {},
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    expect(consumeCachedModelSetupDetection(client)).toEqual(result);
  });

  it("does not redirect after the operator leaves the default landing", async () => {
    const result = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    };
    const request = vi.fn().mockResolvedValue(result);
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const snapshot = {
      connected: true,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    };
    const replace = vi.fn();
    const context = {
      gateway: {
        snapshot,
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      replace,
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => false });
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(replace).not.toHaveBeenCalled();
    expect(consumeCachedModelSetupDetection(client)).toEqual(result);
  });

  it("retries detection with the replacement client after a transient failure", async () => {
    const result = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    };
    const firstRequest = vi.fn().mockRejectedValue(new Error("gateway disconnected"));
    const firstClient = { request: firstRequest } as unknown as GatewayBrowserClient;
    const secondRequest = vi.fn().mockResolvedValue(result);
    const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const snapshot = {
      connected: true,
      client: firstClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    };
    const replace = vi.fn();
    let currentSnapshot = snapshot;
    const context = {
      gateway: {
        get snapshot() {
          return currentSnapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      replace,
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => true });
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledOnce());

    const reconnected = { ...snapshot, client: secondClient };
    currentSnapshot = reconnected;
    listener!(reconnected as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());

    expect(secondRequest).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    expect(consumeCachedModelSetupDetection(secondClient)).toEqual(result);
  });

  it("does not repeat completed detection with a replacement client", async () => {
    const result = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: true,
    };
    const firstRequest = vi.fn().mockResolvedValue(result);
    const firstClient = { request: firstRequest } as unknown as GatewayBrowserClient;
    const secondRequest = vi.fn();
    const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const snapshot = {
      connected: true,
      client: firstClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    };
    let currentSnapshot = snapshot;
    const context = {
      gateway: {
        get snapshot() {
          return currentSnapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      replace: vi.fn(),
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => true });
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(consumeCachedModelSetupDetection(firstClient)).toEqual(result));

    const reconnected = { ...snapshot, client: secondClient };
    currentSnapshot = reconnected;
    listener!(reconnected as Parameters<GatewayListener>[0]);

    expect(firstRequest).toHaveBeenCalledOnce();
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it("does not detect without admin scope or an advertised setup method", () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const context = {
      gateway: {
        snapshot: {},
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      replace: vi.fn(),
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => true });
    listener!({
      connected: true,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    } as Parameters<GatewayListener>[0]);
    listener!({
      connected: true,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: [] },
      },
    } as unknown as Parameters<GatewayListener>[0]);

    expect(request).not.toHaveBeenCalled();
  });
});
