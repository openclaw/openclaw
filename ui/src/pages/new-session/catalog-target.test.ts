import { describe, expect, it, vi } from "vitest";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  CatalogTargetDiscovery,
  resolveCreateTarget,
  routeKey,
  routeKeyFromSearch,
} from "./catalog-target.ts";
import { createNewSessionRouteData } from "./location.test-support.ts";

it("does not discover or retry CLI targets without a current read grant", async () => {
  const request = vi.fn().mockRejectedValue(new Error("unavailable"));
  const context = createApplicationGateway(
    createApplicationGatewaySnapshot({
      phase: "connected",
      client: createTestGatewayClient(request),
    }),
  );
  const discovery = new CatalogTargetDiscovery(() => {});
  const setScopes = (scopes: string[]) => {
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.catalog.list"], scopes);
  };
  setScopes(["operator.sessions.write"]);
  discovery.load(context, "main", true);
  expect(request).not.toHaveBeenCalled();
  expect(discovery.groups()).toBeUndefined();
  setScopes(["operator.read"]);
  discovery.load(context, "main", true);
  await discovery.groups()?.[0]?.completion?.promise.catch(() => {});
  expect(request).toHaveBeenCalledOnce();
  setScopes(["operator.sessions.read"]);
  discovery.load(context, "main", true);
  discovery.retry(context.gateway.snapshot, "main");
  expect(discovery.groups()).toBeUndefined();
  expect(request).toHaveBeenCalledOnce();
  discovery.clear();
});

describe("new-session catalog target", () => {
  it("isolates model-specific drafts while retaining ordinary draft storage keys", () => {
    const plain = createNewSessionRouteData();
    const first = { ...plain, requestedModel: "example/first" };
    const second = { ...plain, requestedModel: "example/second" };
    expect(routeKey(plain)).toBe('["main","",""]');
    expect(routeKey(first)).not.toBe(routeKey(plain));
    expect(routeKey(first)).not.toBe(routeKey(second));
    expect(routeKeyFromSearch("?agent=main&model=example%2Ffirst")).toBe(routeKey(first));
  });

  it("fails closed when the requested creation capability is unavailable", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: { continueSession: true, archive: false },
          hosts: [],
        },
      ],
    }));

    await expect(
      resolveCreateTarget(
        createApplicationGatewaySnapshot({
          client: createTestGatewayClient(request),
          phase: "connected",
          hello: gatewayHelloForMethods(["sessions.catalog.list"]),
        }),
        "claude",
        "research",
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("resolves native terminal hosts without model-chat eligibility", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: {
            continueSession: true,
            archive: false,
            startTerminal: true,
          },
          hosts: [
            {
              hostId: "node:dev",
              label: "Dev",
              kind: "node",
              connected: false,
              canStartTerminal: true,
              sessions: [],
            },
          ],
        },
      ],
    }));

    await expect(
      resolveCreateTarget(
        createApplicationGatewaySnapshot({
          client: createTestGatewayClient(request),
          phase: "connected",
          hello: gatewayHelloForMethods(["sessions.catalog.list"]),
        }),
        "claude",
        "research",
      ),
    ).resolves.toEqual({
      catalogLabel: "Claude Code",
      startTerminal: true,
      terminalHosts: [{ hostId: "node:dev", label: "Dev" }],
    });
  });
});
