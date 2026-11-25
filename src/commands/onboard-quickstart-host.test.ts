import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDisposableEntrypoint } from "../daemon/durable-service-entrypoint.js";
import { VERSION } from "../version.js";
import { t } from "../wizard/i18n/index.js";
import { setEntrypoint } from "./onboard-entrypoint.test-support.js";
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

const testTempDirs = useAutoCleanupTempDirTracker(afterEach);

function createHostHarness(
  config: OpenClawConfig = { gateway: { auth: { mode: "none" } } },
  reopen = { tuiCommand: "openclaw", dashboardCommand: "openclaw dashboard" },
) {
  const gateway = createDeferred();
  const readiness = createDeferred<{ ok: boolean }>();
  const probing = createDeferred();
  const summary = createDeferred();
  const runtime = createTestRuntime();
  runtime.log.mockImplementation((message) => {
    if (message === t("wizard.guided.quickstartReopen", reopen)) {
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

async function captureSummary(params: {
  kind: "npx" | "durable";
  tuiCommand: string;
  dashboardCommand: string;
  ready?: boolean;
}) {
  const entrypoint = await setEntrypoint(
    testTempDirs.make("openclaw-onboard-entrypoint-"),
    params.kind,
  );
  if (params.kind === "npx") {
    expect(await isDisposableEntrypoint(entrypoint)).toBe(true);
  }
  const h = createHostHarness(undefined, {
    tuiCommand: params.tuiCommand,
    dashboardCommand: params.dashboardCommand,
  });
  const host = runQuickstartForegroundGateway({ runtime: h.runtime });
  onTestFinished(async () => {
    h.gateway.resolve();
    await host;
  });
  await h.probing.promise;
  h.readiness.resolve({ ok: params.ready ?? true });
  await h.summary.promise;
  return h.runtime.log;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
  vi.stubEnv("OPENCLAW_PROFILE", "");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
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
  [
    false,
    undefined,
    "wizard.guided.quickstartGatewayPending",
    { statusCommand: "openclaw gateway status" },
  ],
  [true, "timeout", "wizard.guided.quickstartBrowserUnavailable", undefined],
  [true, "error", "wizard.guided.quickstartBrowserUnavailable", undefined],
] as const)("retains Gateway: ready=%s, browser=%s", async (ok, failure, message, params) => {
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
  expect(h.runtime.log).toHaveBeenCalledWith(t(message, params));
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
  expect(h.runtime.log).not.toHaveBeenCalledWith(
    t("wizard.guided.quickstartReopen", {
      tuiCommand: "openclaw",
      dashboardCommand: "openclaw dashboard",
    }),
  );
  handoff.resolve(true);
});

it("npx foreground summary formats both background and reopen commands", async () => {
  const cli = `npx openclaw@${VERSION}`;
  const log = await captureSummary({
    kind: "npx",
    tuiCommand: cli,
    dashboardCommand: `${cli} dashboard`,
  });
  expect(log).toHaveBeenCalledWith(
    `To keep the Gateway running in the background later: ${cli} gateway install`,
  );
  expect(log).toHaveBeenCalledWith(
    `Run ${cli} to open the TUI, or ${cli} dashboard to reopen the web dashboard.`,
  );
});

it.each([
  [
    "durable",
    "",
    "openclaw",
    "openclaw dashboard",
    "Run openclaw to open the TUI, or openclaw dashboard to reopen the web dashboard.",
  ],
  [
    "durable",
    "work",
    "openclaw --profile work",
    "openclaw --profile work dashboard",
    "Run openclaw --profile work to open the TUI, or openclaw --profile work dashboard to reopen the web dashboard.",
  ],
  [
    "npx",
    "work",
    `npx openclaw@${VERSION} --profile work`,
    `npx openclaw@${VERSION} --profile work dashboard`,
    `Run npx openclaw@${VERSION} --profile work to open the TUI, or npx openclaw@${VERSION} --profile work dashboard to reopen the web dashboard.`,
  ],
] as const)(
  "%s entrypoint with profile %s formats reopen exactly",
  async (kind, profile, tuiCommand, dashboardCommand, expected) => {
    vi.stubEnv("OPENCLAW_PROFILE", profile);
    const log = await captureSummary({ kind, tuiCommand, dashboardCommand });
    expect(log).toHaveBeenCalledWith(expected);
  },
);

it.each([
  ["zh-CN", "运行 openclaw dashboard"],
  ["zh-TW", "執行 openclaw dashboard"],
] as const)("npx reopen is interpolated in %s", async (locale, bareDashboard) => {
  vi.stubEnv("OPENCLAW_LOCALE", locale);
  const cli = `npx openclaw@${VERSION}`;
  const log = await captureSummary({
    kind: "npx",
    tuiCommand: cli,
    dashboardCommand: `${cli} dashboard`,
  });
  const output = log.mock.calls.map(([message]) => message).join("\n");
  expect(output).toContain(`${cli} dashboard`);
  expect(output).not.toContain(bareDashboard);
});

it.each([
  ["npx", "en"],
  ["npx", "zh-CN"],
  ["npx", "zh-TW"],
  ["durable", "en"],
] as const)("%s pending hint is formatted in %s", async (kind, locale) => {
  vi.stubEnv("OPENCLAW_LOCALE", locale);
  const cli = kind === "npx" ? `npx openclaw@${VERSION}` : "openclaw";
  const log = await captureSummary({
    kind,
    tuiCommand: cli,
    dashboardCommand: `${cli} dashboard`,
    ready: false,
  });
  const output = log.mock.calls.map(([message]) => message).join("\n");
  if (kind === "npx") {
    expect(output).toContain(`npx openclaw@${VERSION} gateway status`);
    expect(output).not.toContain("openclaw gateway status");
  } else {
    expect(log).toHaveBeenCalledWith(
      "The Gateway is not reachable yet. Keep this terminal open and run openclaw gateway status to check startup.",
    );
  }
});
