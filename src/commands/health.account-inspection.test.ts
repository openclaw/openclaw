import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadFreshHealthModulesForTest,
  type HealthTestPlugin,
} from "./health.snapshot.test-support.js";

const tempDirs = createTempDirTracker();
let plugins: HealthTestPlugin[] = [];
let sessionStorePath: string;
let health: Awaited<ReturnType<typeof loadFreshHealthModulesForTest>>;

async function inspectAccounts(
  config: HealthTestPlugin["config"],
  status: HealthTestPlugin["status"],
) {
  const id = "health-inspection-fixture";
  plugins = [
    { ...health.createChannelTestPluginBase({ id, label: "Inspection" }), config, status },
  ];
  return (await health.collectGatewayHealthSnapshot({ audience: "admin", probe: true })).channels[
    id
  ]?.accounts;
}
beforeAll(async () => {
  health = await loadFreshHealthModulesForTest({
    getConfig: () => ({}),
    getSessionStorePath: () => sessionStorePath,
    getPlugins: () => plugins,
  });
});

beforeEach(() => {
  sessionStorePath = path.join(tempDirs.make("openclaw-health-inspection-"), "sessions.json");
  plugins = [];
  health.setActiveDegradedPlugins([]);
  health.setActivePluginRegistry(health.createTestRegistry([]));
});

afterEach(() => {
  health.setActivePluginRegistry(health.createTestRegistry([]));
  tempDirs.cleanup();
});

it.each([false, true])(
  "keeps unavailable accounts visible (resolved sibling=%s)",
  async (withSibling) => {
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const runtimeOnly = vi.fn(() =>
      expect.unreachable("runtime hook received an inspection summary"),
    );
    const buildAccountSnapshot = vi.fn(({ account }: { account: unknown }) => {
      expect(account).toMatchObject({ token: "healthy-token" });
      return { accountId: "healthy", configured: true, name: "Resolved healthy account" };
    });
    const accounts = await inspectAccounts(
      {
        listAccountIds: () => (withSibling ? ["default", "healthy"] : ["default"]),
        resolveAccount: (_cfg, accountId) => {
          if (!withSibling || accountId !== "healthy") {
            throw new Error("credential unavailable");
          }
          return { accountId, enabled: true, configured: true, token: "healthy-token" };
        },
        inspectAccount: (_cfg, accountId) =>
          withSibling
            ? {
                accountId,
                enabled: true,
                configured: true,
                tokenStatus: accountId === "healthy" ? "available" : "configured_unavailable",
              }
            : undefined,
      },
      withSibling
        ? { probeAccount, buildAccountSnapshot }
        : {
            probeAccount: runtimeOnly,
            buildAccountSnapshot: runtimeOnly,
            buildChannelSummary: runtimeOnly,
          },
    );
    if (withSibling) {
      expect(accounts).toMatchObject({
        default: { configured: true, tokenStatus: "configured_unavailable" },
        healthy: { configured: true, name: "Resolved healthy account" },
      });
      expect(probeAccount).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          account: expect.objectContaining({ accountId: "healthy", token: "healthy-token" }),
        }),
      );
      expect(buildAccountSnapshot).toHaveBeenCalledTimes(1);
    } else {
      expect(accounts?.default?.configured).toBeUndefined();
      expect(accounts?.default?.stateReason).toBe("configuration status unavailable");
      expect(runtimeOnly).not.toHaveBeenCalled();
    }
  },
);
