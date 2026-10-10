/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScopeUpgradeCapability } from "../../app/device-scope-upgrade.ts";
import { createMentionsCapability } from "../../app/mentions.ts";
import { client, createGatewayHarness } from "../../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { createPlacementStartupHarness } from "../../app/session-placement-startup.test-support.ts";
import { createWebPushCapability } from "../../app/web-push.ts";
import { createStore, cronPage } from "../../components/sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreController } from "../../components/sidebar-attention-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { verifyApplicationProjection } from "./application-test-support.ts";
import {
  projectMentions,
  projectOverlays,
  projectPlacementStartup,
  projectScopeUpgrade,
  projectSidebarAttention,
  projectWebPush,
} from "./application.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("application capability projections", () => {
  it("projects admitted overlay state and releases a replaced owner", async () => {
    await verifyApplicationProjection({
      create: () => {
        const harness = createGatewayHarness(client(async () => []));
        const source = createApplicationOverlays(harness.gateway);
        return {
          source,
          update: () => source.openDevicePairSetup(),
          dispose: () => source.dispose(),
        };
      },
      project: projectOverlays,
      select: (value) => value.devicePairSetupOpen,
      initial: false,
      updated: true,
    });
  });

  it("projects profile-scoped mention hydration through the owner", async () => {
    await verifyApplicationProjection({
      create: () => {
        const harness = createGatewayHarness(null);
        const source = createMentionsCapability(harness.gateway);
        const connected = client(async () => ({
          gatewayInstanceId: "projection-boot",
          revision: 1,
          items: [],
        }));
        return {
          source,
          update: async () => {
            harness.update({
              client: connected,
              phase: "connected",
              hello: {
                type: "hello-ok",
                protocol: 1,
                server: { bootId: "projection-boot", connId: "projection-connection" },
                auth: { role: "operator", scopes: ["operator.read"] },
                features: { methods: ["mentions.list"] },
              },
              selfUser: { id: "reader", identity: { type: "profile", id: "reader" } },
            });
            await source.refresh();
          },
          dispose: () => source.dispose(),
        };
      },
      project: projectMentions,
      select: (value) => value.phase,
      initial: "unavailable",
      updated: "ready",
    });
  });

  it("observes scope-upgrade availability without activating its lazy controller", async () => {
    await verifyApplicationProjection({
      create: () => {
        const harness = createGatewayHarness(null);
        const source = createScopeUpgradeCapability(harness.gateway);
        return {
          source,
          update: () =>
            harness.update({
              phase: "connected",
              hello: {
                type: "hello-ok",
                protocol: 1,
                auth: {
                  role: "operator",
                  scopes: ["operator.read"],
                },
              },
            }),
          dispose: () => source.dispose(),
        };
      },
      project: projectScopeUpgrade,
      select: (value) => value.phase,
      initial: "hidden",
      updated: "guidance",
    });
  });

  it("projects lazy sidebar attention after the controller admits its inventory", async () => {
    await verifyApplicationProjection({
      create: () => {
        const harness = createGatewayHarness(null);
        const source = createStore(harness.gateway);
        source.activate(SidebarAttentionStoreController);
        const connected = client(async (method) =>
          method === "cron.list"
            ? cronPage("projection-job")
            : method === "cron.status"
              ? { enabled: true, triggersEnabled: true, jobs: 1 }
              : { ts: 1, providers: [] },
        );
        return {
          source,
          update: async () => {
            if (source.entries.length) {
              harness.update({ client: connected, phase: "connected" });
              return;
            }
            await new Promise<void>((resolve) => {
              const stop = source.subscribe(() => {
                if (source.entries.length) {
                  stop();
                  resolve();
                }
              });
              harness.update({ client: connected, phase: "connected" });
            });
          },
          dispose: () => source.dispose(),
        };
      },
      project: projectSidebarAttention,
      select: (value) =>
        value.flatMap((entry) => (entry.type === "attention" ? [entry.label] : [])),
      initial: [],
      updated: ["projection-job"],
    });
  });

  it("publishes in-place Web Push snapshot mutations", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "projection-test",
      platform: "Linux",
      maxTouchPoints: 0,
      serviceWorker: { getRegistration: async () => undefined },
    });
    vi.stubGlobal("PushManager", vi.fn());
    vi.stubGlobal("Notification", { permission: "granted" });
    await verifyApplicationProjection({
      create: () => {
        const harness = createGatewayHarness(
          client(async () => {
            throw new Error("Synthetic notification failure");
          }),
        );
        const source = createWebPushCapability(harness.gateway);
        return {
          source,
          update: () => source.run({ kind: "test" }),
          dispose: () => source.dispose(),
        };
      },
      project: projectWebPush,
      select: (value) => value.error ?? null,
      initial: null,
      updated: "Synthetic notification failure",
    });
  });

  it("reads placement status through the lazy facade without starting work on observation", async () => {
    const loaders: Array<ReturnType<typeof vi.fn>> = [];
    await verifyApplicationProjection({
      create: () => {
        const loadRuntime = vi.fn(() => new Promise<never>(() => {}));
        loaders.push(loadRuntime);
        const { startup, input, sessions } = createPlacementStartupHarness(vi.fn(), {
          loadRuntime,
        });
        return {
          source: { startup, sessions, sessionKey: input.recovery.sessionKey },
          update: () => startup.start(input),
          dispose: () => startup.dispose(),
        };
      },
      project: projectPlacementStartup,
      select: (value) => ({ phase: value.status?.phase, pending: value.hasPendingTurn }),
      initial: { phase: undefined, pending: false },
      updated: { phase: "pending", pending: true },
    });
    expect(loaders.every((loader) => loader.mock.calls.length === 1)).toBe(true);
  });
});
