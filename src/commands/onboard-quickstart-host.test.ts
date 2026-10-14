import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import { runQuickstartForegroundGateway } from "./onboard-quickstart-host.js";

const mocks = vi.hoisted(() => ({
  readConfigSnapshot: vi.fn(),
  runGateway: vi.fn<typeof import("../cli/gateway-cli/run.js").runGatewayCommand>(),
  waitForGateway: vi.fn<typeof import("./onboard-helpers.js").waitForGatewayReachable>(),
  runBrowserHandoff: vi.fn<typeof import("./onboard-browser-handoff.js").runBrowserHatchHandoff>(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigSnapshot,
}));
// mock-isolation: Keep foreground Gateway process-lifecycle state outside this handoff fixture.
vi.mock("../cli/gateway-cli/run.js", () => ({ runGatewayCommand: mocks.runGateway }));
vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  waitForGatewayReachable: mocks.waitForGateway,
}));
vi.mock("./onboard-browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-browser-handoff.js")>()),
  runBrowserHatchHandoff: mocks.runBrowserHandoff,
}));

function createHostHarness(config: OpenClawConfig = { gateway: { auth: { mode: "none" } } }) {
  const events: string[] = [];
  const gateway = createDeferred();
  const readiness = createDeferred<{ ok: boolean }>();
  const probing = createDeferred();
  const summary = createDeferred();
  const runtime: RuntimeEnv = {
    log: vi.fn((message) => {
      if (message === t("wizard.guided.quickstartReopen")) {
        summary.resolve();
      }
    }),
    error: vi.fn(),
    exit: vi.fn(),
  };
  mocks.readConfigSnapshot.mockResolvedValue({ config });
  mocks.runGateway.mockImplementation(() => {
    events.push("gateway started");
    return gateway.promise;
  });
  mocks.waitForGateway.mockImplementation(() => {
    events.push("readiness probe");
    probing.resolve();
    return readiness.promise;
  });
  mocks.runBrowserHandoff.mockImplementation(async () => {
    events.push("browser handoff");
    return { handedOff: true };
  });
  return { config, events, gateway, readiness, probing, summary, runtime };
}

describe("runQuickstartForegroundGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    vi.stubEnv("OPENCLAW_LOCALE", "en");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["token", "password", "trusted-proxy"] as const)(
    "starts the Gateway and verifies %s auth before opening the dashboard",
    async (mode) => {
      const h = createHostHarness({
        gateway: {
          mode: "local",
          bind: "loopback",
          port: 19431,
          auth: {
            mode,
            ...(mode === "token"
              ? { token: "synthetic-token" }
              : { password: "synthetic-password" }),
            ...(mode === "trusted-proxy"
              ? { trustedProxy: { userHeader: "x-forwarded-user" } }
              : {}),
          },
          controlUi: { basePath: "/dashboard" },
        },
      });
      const host = runQuickstartForegroundGateway({ runtime: h.runtime });
      await h.probing.promise;

      expect(h.events).toEqual(["gateway started", "readiness probe"]);
      expect(mocks.runBrowserHandoff).not.toHaveBeenCalled();
      expect(mocks.waitForGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "ws://127.0.0.1:19431/dashboard",
          token: mode === "token" ? "synthetic-token" : undefined,
          password: mode === "token" ? undefined : "synthetic-password",
        }),
      );

      h.readiness.resolve({ ok: true });
      await h.summary.promise;
      expect(h.events).toEqual(["gateway started", "readiness probe", "browser handoff"]);
      expect(mocks.runBrowserHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ config: h.config }),
      );
      expect(h.runtime.log).toHaveBeenCalledWith("Dashboard: http://127.0.0.1:19431/dashboard/");
      expect(h.runtime.log).toHaveBeenCalledWith(expect.stringContaining("Ctrl+C"));
      expect(h.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("openclaw gateway install"),
      );
      expect(h.runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw dashboard"));

      h.gateway.resolve();
      await host;
      expect(h.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("surfaces startup failure without waiting for the readiness timeout", async () => {
    const h = createHostHarness();
    const host = runQuickstartForegroundGateway({ runtime: h.runtime });
    const failed = expect(host).rejects.toThrow("startup failed");
    await h.probing.promise;
    h.gateway.reject(new Error("startup failed"));

    await failed;
    expect(mocks.runBrowserHandoff).not.toHaveBeenCalled();
  });

  it.each(["timeout", "error"] as const)(
    "keeps owning the Gateway after a browser handoff %s",
    async (failure) => {
      const h = createHostHarness();
      mocks.runBrowserHandoff.mockImplementation(async () => {
        if (failure === "error") {
          throw new Error("browser unavailable");
        }
        return { handedOff: false, reason: "timeout" };
      });
      const host = runQuickstartForegroundGateway({ runtime: h.runtime });
      const stopped = expect(host).rejects.toThrow("later Gateway failure");
      await h.probing.promise;
      h.readiness.resolve({ ok: true });
      await h.summary.promise;

      expect(h.runtime.log).toHaveBeenCalledWith(t("wizard.guided.quickstartBrowserUnavailable"));
      expect(h.runtime.exit).not.toHaveBeenCalled();
      h.gateway.reject(new Error("later Gateway failure"));
      await stopped;
    },
  );

  it("surfaces Gateway failure while browser handoff is still pending", async () => {
    const h = createHostHarness();
    const handoffStarted = createDeferred();
    const handoff = createDeferred<{ handedOff: true }>();
    mocks.runBrowserHandoff.mockImplementation(() => {
      handoffStarted.resolve();
      return handoff.promise;
    });
    const host = runQuickstartForegroundGateway({ runtime: h.runtime });
    const stopped = expect(host).rejects.toThrow("Gateway failed during handoff");
    await h.probing.promise;
    h.readiness.resolve({ ok: true });
    await handoffStarted.promise;
    h.gateway.reject(new Error("Gateway failed during handoff"));

    await stopped;
    expect(h.runtime.log).not.toHaveBeenCalledWith(t("wizard.guided.quickstartBrowserUnavailable"));
    handoff.resolve({ handedOff: true });
  });

  it("keeps the foreground Gateway alive when readiness is not confirmed", async () => {
    const h = createHostHarness();
    const host = runQuickstartForegroundGateway({ runtime: h.runtime });
    const stopped = expect(host).rejects.toThrow("later Gateway failure");
    await h.probing.promise;
    h.readiness.resolve({ ok: false });
    await h.summary.promise;

    expect(mocks.runBrowserHandoff).not.toHaveBeenCalled();
    expect(h.runtime.log).toHaveBeenCalledWith(t("wizard.guided.quickstartGatewayPending"));
    h.gateway.reject(new Error("later Gateway failure"));
    await stopped;
  });
});
