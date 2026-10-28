import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { t } from "../wizard/i18n/index.js";
import { runQuickstartForegroundGateway } from "./onboard-quickstart-host.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readConfigSnapshot: vi.fn(),
  startGateway:
    vi.fn<typeof import("./onboard-gateway-process.js").startOnboardingGatewayProcess>(),
  waitForGateway: vi.fn<typeof import("./onboard-helpers.js").waitForGatewayReachable>(),
  runBrowserHandoff: vi.fn<typeof import("./onboard-browser-handoff.js").runBrowserHatchHandoff>(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigSnapshot,
}));
// mock-isolation: Keep foreground Gateway process-lifecycle state outside this handoff fixture.
vi.mock("./onboard-gateway-process.js", () => ({
  startOnboardingGatewayProcess: mocks.startGateway,
}));
vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  waitForGatewayReachable: mocks.waitForGateway,
}));
vi.mock("./onboard-browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-browser-handoff.js")>()),
  runBrowserHatchHandoff: mocks.runBrowserHandoff,
}));

function createHostHarness(config: OpenClawConfig = { gateway: { auth: { mode: "none" } } }) {
  const gateway = createDeferred();
  const readiness = createDeferred<{ ok: boolean }>();
  const probing = createDeferred();
  const summary = createDeferred();
  const runtime = createTestRuntime();
  runtime.log.mockImplementation((message) => {
    if (message === t("wizard.guided.quickstartReopen")) {
      summary.resolve();
    }
  });
  mocks.readConfigSnapshot.mockResolvedValue({ config });
  const close = vi.fn(async () => {});
  mocks.startGateway.mockResolvedValue({ wait: gateway.promise, close });
  mocks.waitForGateway.mockImplementation(() => {
    probing.resolve();
    return readiness.promise;
  });
  mocks.runBrowserHandoff.mockResolvedValue(true);
  return { config, gateway, readiness, probing, summary, runtime, close };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
  vi.stubEnv("OPENCLAW_LOCALE", "en");
});

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["token", "synthetic-token", undefined, undefined],
  ["password", undefined, "synthetic-password", undefined],
  ["trusted-proxy", undefined, "synthetic-password", { userHeader: "x-forwarded-user" }],
] as const)("%s auth before dashboard", async (mode, token, password, trustedProxy) => {
  const h = createHostHarness({
    gateway: {
      port: 19431,
      auth: { mode, token, password, trustedProxy },
      controlUi: { basePath: "/dashboard" },
    },
  });
  const host = runQuickstartForegroundGateway({ runtime: h.runtime });
  await h.probing.promise;

  expect(mocks.startGateway).toHaveBeenCalledBefore(mocks.waitForGateway);
  expect(mocks.runBrowserHandoff).not.toHaveBeenCalled();
  expect(mocks.waitForGateway).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: "ws://127.0.0.1:19431/dashboard",
      token,
      password,
    }),
  );

  h.readiness.resolve({ ok: true });
  await h.summary.promise;
  expect(mocks.waitForGateway).toHaveBeenCalledBefore(mocks.runBrowserHandoff);
  expect(h.runtime.log).toHaveBeenCalledWith("Dashboard: http://127.0.0.1:19431/dashboard/");

  h.gateway.resolve();
  await host;
  expect(h.runtime.exit).not.toHaveBeenCalled();
  expect(h.close).toHaveBeenCalledOnce();
});

it("preserves startup failure when process cleanup also fails", async () => {
  const h = createHostHarness();
  h.close.mockRejectedValueOnce(new Error("cleanup failed"));
  const host = runQuickstartForegroundGateway({ runtime: h.runtime });
  const failed = expect(host).rejects.toThrow("startup failed");
  await h.probing.promise;
  h.gateway.reject(new Error("startup failed"));

  await failed;
  expect(h.runtime.error).toHaveBeenCalledWith("cleanup failed");
  expect(mocks.runBrowserHandoff).not.toHaveBeenCalled();
});

it.each([
  [false, undefined, "wizard.guided.quickstartGatewayPending"],
  [true, "timeout", "wizard.guided.quickstartBrowserUnavailable"],
  [true, "error", "wizard.guided.quickstartBrowserUnavailable"],
] as const)("retains Gateway: ready=%s, browser=%s", async (ok, failure, message) => {
  const h = createHostHarness();
  if (failure) {
    mocks.runBrowserHandoff.mockImplementation(async () => {
      if (failure === "error") {
        throw new Error("browser unavailable");
      }
      return false;
    });
  }
  const host = runQuickstartForegroundGateway({ runtime: h.runtime });
  await h.probing.promise;
  h.readiness.resolve({ ok });
  await Promise.race([
    h.summary.promise,
    host.then(() => {
      throw new Error("foreground Gateway ownership ended after browser fallback");
    }),
  ]);

  if (!ok) {
    expect(mocks.runBrowserHandoff).not.toHaveBeenCalled();
  }
  expect(h.runtime.log).toHaveBeenCalledWith(t(message));
  expect(h.runtime.exit).not.toHaveBeenCalled();
  const stopped = expect(host).rejects.toThrow("later Gateway failure");
  h.gateway.reject(new Error("later Gateway failure"));
  await stopped;
});

it.each(["stopped", "failed"] as const)("settles %s during pending handoff", async (outcome) => {
  const h = createHostHarness();
  const handoffStarted = createDeferred();
  const handoff = createDeferred<boolean>();
  mocks.runBrowserHandoff.mockImplementation(() => {
    handoffStarted.resolve();
    return handoff.promise;
  });
  const host = runQuickstartForegroundGateway({ runtime: h.runtime });
  const settled =
    outcome === "stopped"
      ? expect(host).resolves.toBeUndefined()
      : expect(host).rejects.toThrow("Gateway failed during handoff");
  await h.probing.promise;
  h.readiness.resolve({ ok: true });
  await handoffStarted.promise;
  if (outcome === "stopped") {
    h.gateway.resolve();
  } else {
    h.gateway.reject(new Error("Gateway failed during handoff"));
  }

  await settled;
  expect(h.runtime.log).not.toHaveBeenCalledWith(t("wizard.guided.quickstartBrowserUnavailable"));
  expect(h.runtime.log).not.toHaveBeenCalledWith(t("wizard.guided.quickstartReopen"));
  handoff.resolve(true);
});
