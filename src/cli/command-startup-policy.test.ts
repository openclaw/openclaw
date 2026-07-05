// Command startup policy tests cover which CLI commands require startup side effects.
import { describe, expect, it } from "vitest";
import {
  resolveCliStartupPolicy,
  shouldBypassConfigGuardForCommandPath,
<<<<<<< HEAD
} from "./command-startup-policy.js";

function resolvePolicy(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  return resolveCliStartupPolicy({
    jsonOutputMode: false,
    ...params,
  });
}

=======
  shouldEnsureCliPathForCommandPath,
  shouldHideCliBannerForCommandPath,
  shouldLoadPluginsForCommandPath,
  shouldSkipRouteConfigGuardForCommandPath,
} from "./command-startup-policy.js";

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
describe("command-startup-policy", () => {
  it("matches config guard bypass commands", () => {
    expect(shouldBypassConfigGuardForCommandPath(["backup", "create"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "validate"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "schema"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "set"])).toBe(false);
    expect(shouldBypassConfigGuardForCommandPath(["status"])).toBe(false);
  });

  it("matches route-first config guard skip policy", () => {
    expect(
<<<<<<< HEAD
      resolvePolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        routeMode: true,
      }).skipConfigGuard,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["gateway", "status"],
        routeMode: true,
      }).skipConfigGuard,
    ).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        routeMode: true,
      }).skipConfigGuard,
=======
      shouldSkipRouteConfigGuardForCommandPath({
        commandPath: ["status"],
        suppressDoctorStdout: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipRouteConfigGuardForCommandPath({
        commandPath: ["gateway", "status"],
        suppressDoctorStdout: false,
      }),
    ).toBe(true);
    expect(
      shouldSkipRouteConfigGuardForCommandPath({
        commandPath: ["status"],
        suppressDoctorStdout: false,
      }),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ).toBe(false);
  });

  it("matches plugin preload policy", () => {
    expect(
<<<<<<< HEAD
      resolvePolicy({
        commandPath: ["status"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["health"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "status"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "list"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "add"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "logs"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["message", "send"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["message", "send"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--json"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--json", "--local"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(true);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }).loadPlugins,
    ).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["agents"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "list"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "list"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "bind"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "bindings"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "unbind"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "set-identity"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "delete"],
        jsonOutputMode: true,
      }).loadPlugins,
=======
      shouldLoadPluginsForCommandPath({
        commandPath: ["status"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["status"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["health"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "status"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "list"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "add"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "logs"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["message", "send"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["message", "send"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        argv: ["node", "openclaw", "agent", "--json"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        argv: ["node", "openclaw", "agent", "--json", "--local"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadPluginsForCommandPath({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
        jsonOutputMode: false,
      }),
    ).toBe(true);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "list"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "list"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "bind"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "bindings"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "unbind"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "set-identity"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "delete"],
        jsonOutputMode: true,
      }),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ).toBe(false);
  });

  it("matches banner suppression policy", () => {
<<<<<<< HEAD
    expect(resolvePolicy({ commandPath: ["update", "status"], env: {} }).hideBanner).toBe(true);
    expect(resolvePolicy({ commandPath: ["completion"], env: {} }).hideBanner).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        env: {
          ...process.env,
          OPENCLAW_HIDE_BANNER: "1",
        },
      }).hideBanner,
    ).toBe(true);
    expect(resolvePolicy({ commandPath: ["status"], env: {} }).hideBanner).toBe(false);
=======
    expect(shouldHideCliBannerForCommandPath(["update", "status"])).toBe(true);
    expect(shouldHideCliBannerForCommandPath(["completion"])).toBe(true);
    expect(
      shouldHideCliBannerForCommandPath(["status"], {
        ...process.env,
        OPENCLAW_HIDE_BANNER: "1",
      }),
    ).toBe(true);
    expect(shouldHideCliBannerForCommandPath(["status"], {})).toBe(false);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("uses process env banner suppression when startup env is omitted", () => {
    const originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    try {
      process.env.OPENCLAW_HIDE_BANNER = "1";

      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
        }).hideBanner,
      ).toBe(true);
      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
          env: {},
        }).hideBanner,
      ).toBe(false);
    } finally {
      if (originalHideBanner === undefined) {
        delete process.env.OPENCLAW_HIDE_BANNER;
      } else {
        process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
      }
    }
  });

<<<<<<< HEAD
=======
  it("matches CLI PATH bootstrap policy", () => {
    expect(shouldEnsureCliPathForCommandPath(["status"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["sessions"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["config", "get"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["models", "status"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["tools", "effective"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["message", "send"])).toBe(true);
    expect(shouldEnsureCliPathForCommandPath([])).toBe(true);
  });

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  it("aggregates startup policy for commander and route-first callers", () => {
    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        env: {},
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: false,
      loadPlugins: false,
      pluginRegistry: { scope: "channels" },
    });

    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        env: {},
        routeMode: true,
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: false,
      loadPlugins: false,
      pluginRegistry: { scope: "channels" },
    });
  });
});
