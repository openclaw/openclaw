import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(async () => ({ nextConfig: {}, persistedHash: "persisted-hash" })),
  resolveConfigSnapshotHash: vi.fn(() => "missing-config-revision"),
}));
const secretsMocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
  } | null,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  replaceConfigFile: configMocks.replaceConfigFile,
  resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
}));

const restartMocks = vi.hoisted(() => ({
  scheduleGatewayRestart: vi.fn(() => ({ ok: true, delayMs: 0 })),
}));

vi.mock("../../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart.js")>()),
  scheduleGatewayRestart: restartMocks.scheduleGatewayRestart,
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  writeRestartSentinel: vi.fn(async () => {}),
}));

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime-state.js")>()),
  getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
}));

const billingMocks = vi.hoisted(() => ({
  collect: vi.fn((_params: { before: OpenClawConfig; after: OpenClawConfig }): string[] => []),
}));

// The comparator owns its own tests; these cases prove only the Gateway write wiring.
vi.mock(
  "../../commands/doctor/shared/model-billing-route-migration.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../commands/doctor/shared/model-billing-route-migration.js")
    >()),
    collectModelBillingRouteMigrationWarnings: billingMocks.collect,
  }),
);

import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  resolveGatewayConfigRestartWriteResult,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";

const authConfig = (
  token?: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"],
): OpenClawConfig => ({
  gateway: { auth: { mode: "token", ...(token === undefined ? {} : { token }) } },
});
const runtimeConfig = authConfig("runtime-token");
const authoredConfig = authConfig();

const transcripts: OpenClawConfig = {
  transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "After" }] },
};
const coldStorage: OpenClawConfig = {
  session: { maintenance: { coldStorage: { enabled: true, afterDays: 7 } } },
};
it.each([
  ["transcripts", transcripts, ["transcripts.autoStart"], true],
  [
    "cold storage",
    coldStorage,
    ["session.maintenance.coldStorage.enabled", "session.maintenance.coldStorage.afterDays"],
    true,
  ],
  ["restart", { gateway: { port: 19001 } }, ["gateway.port"], false],
  ["disabled reload", { gateway: { reload: { mode: "off" } } }, ["transcripts.autoStart"], false],
] satisfies [string, OpenClawConfig, string[], boolean][])(
  "awaits %s only when the reload owner can apply it",
  (_name, next, paths, awaited) => {
    expect(
      shouldAwaitGatewayConfigApplication({
        previousConfig: {},
        nextConfig: next,
        changedPaths: paths,
      }),
    ).toBe(awaited);
  },
);

it.each([
  { mode: "off", path: "gateway.nodes.commands.allow", cli: false, restart: true },
  { mode: "off", path: "gateway.nodes.commands.allow", cli: true, restart: false },
  { mode: "hybrid", path: "gateway.port", cli: true, restart: false },
  { mode: "restart", path: "gateway.port", cli: true, restart: false },
] as const)(
  "schedules a direct restart for $path under reload $mode (CLI caller: $cli): $restart",
  async ({ mode, path, cli, restart }) => {
    restartMocks.scheduleGatewayRestart.mockClear();
    const result = await resolveGatewayConfigRestartWriteResult({
      requestParams: {},
      kind: "config-patch",
      mode: "config.patch",
      configPath: "/tmp/openclaw.json",
      changedPaths: [path],
      previousConfig: { gateway: { reload: { mode } } },
      nextConfig: { gateway: { reload: { mode }, port: 19001 } },
      client: {
        connect: {
          client: cli ? { id: "cli", mode: "cli" } : { id: "openclaw-control-ui", mode: "webchat" },
        },
      } as never,
    });
    // Hybrid and restart modes leave restart-required changes to the config reloader.
    expect(result.payload.stats?.requiresRestart).toBe(true);
    expect(result.restart !== undefined).toBe(restart);
    expect(restartMocks.scheduleGatewayRestart).toHaveBeenCalledTimes(restart ? 1 : 0);
  },
);

it("carries a missing file revision into the lock-time compare-and-swap", async () => {
  await commitGatewayConfigWrite({
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      hash: "missing-config-revision",
    } as never,
    writeOptions: {},
    nextConfig: {},
  });
  expect(configMocks.replaceConfigFile).toHaveBeenCalledWith(
    expect.objectContaining({ baseHash: "missing-config-revision", sourceConfig: {} }),
  );
});

const tokenA = authConfig("token-a");
const tokenB = authConfig("token-b");
const secretRef = authConfig({ source: "env", provider: "default", id: "GATEWAY_TOKEN" });
it.each([
  ["runtime-only fields", {}, {}, runtimeConfig, runtimeConfig, undefined, false],
  ["stale authored source", tokenA, tokenA, tokenB, tokenA, tokenB, true],
  [
    "runtime-only siblings",
    authoredConfig,
    authoredConfig,
    runtimeConfig,
    runtimeConfig,
    authoredConfig,
    false,
  ],
  [
    "matching secret source",
    secretRef,
    authConfig("old-token"),
    secretRef,
    authConfig("new-token"),
    secretRef,
    true,
  ],
] as const)(
  "compares shared auth with %s",
  (_name, sourceConfig, config, fallbackPrev, next, fallbackSource, expected) => {
    secretsMocks.activeSnapshot = { sourceConfig, config };
    expect(didActiveSharedGatewayAuthChange({ fallbackPrev, next, fallbackSource })).toBe(expected);
  },
);

const writeSnapshot = (sourceConfig: OpenClawConfig) =>
  ({ path: "/tmp/openclaw.json", exists: true, raw: "{}", hash: "h", sourceConfig }) as never;
const cliModel = (runtime: string): OpenClawConfig => ({
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: runtime } } },
    },
  },
});

it("returns billing-route warnings for a committed model write without logging them early", async () => {
  const warning = "Billing route changed for agents.defaults.subagents.model (agent main).";
  billingMocks.collect.mockReset().mockReturnValue([warning]);
  const warn = vi.fn();
  const result = await commitGatewayConfigWrite({
    snapshot: writeSnapshot(cliModel("claude-cli")),
    writeOptions: {},
    nextConfig: cliModel("openclaw"),
    context: { logGateway: { warn } } as never,
  });
  expect(billingMocks.collect).toHaveBeenCalledWith(
    expect.objectContaining({ before: cliModel("claude-cli"), after: cliModel("openclaw") }),
  );
  expect(result.billingRouteWarnings).toEqual([warning]);
  // The reply logs with the success response, after application settles.
  expect(warn).not.toHaveBeenCalled();
});

it("adds and logs billing-route warnings only on a successful reply", async () => {
  billingMocks.collect.mockReset().mockReturnValue(["route moved"]);
  const warn = vi.fn();
  const respond = vi.fn();
  const { reply } = await commitGatewayConfigWrite({
    snapshot: writeSnapshot(cliModel("claude-cli")),
    writeOptions: {},
    nextConfig: cliModel("openclaw"),
    context: { logGateway: { warn } } as never,
    respond,
  });
  reply(false, undefined, { code: "UNAVAILABLE", message: "not applied" });
  expect(warn).not.toHaveBeenCalled();
  reply(true, { ok: true });
  expect(respond).toHaveBeenLastCalledWith(true, {
    ok: true,
    billingRouteWarnings: ["route moved"],
  });
  expect(warn).toHaveBeenCalledWith("route moved");
});

it("keeps the committed write when the billing comparison fails or has nothing to compare", async () => {
  billingMocks.collect.mockReset().mockImplementation(() => {
    throw new Error("auth store unavailable");
  });
  const warn = vi.fn();
  const failed = await commitGatewayConfigWrite({
    snapshot: writeSnapshot(cliModel("claude-cli")),
    writeOptions: {},
    nextConfig: cliModel("openclaw"),
    context: { logGateway: { warn } } as never,
  });
  expect(failed).toMatchObject({ hash: "persisted-hash" });
  expect(failed).not.toHaveProperty("billingRouteWarnings");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("billing route comparison skipped"));

  billingMocks.collect.mockClear();
  await commitGatewayConfigWrite({
    snapshot: writeSnapshot(transcripts),
    writeOptions: {},
    nextConfig: coldStorage,
  });
  const workspace = (dir: string): OpenClawConfig => ({
    ...cliModel("claude-cli"),
    agents: { ...cliModel("claude-cli").agents, entries: { main: { workspace: dir } } },
  });
  await commitGatewayConfigWrite({
    snapshot: writeSnapshot(workspace("/work/a")),
    writeOptions: {},
    nextConfig: workspace("/work/b"),
  });
  expect(billingMocks.collect).not.toHaveBeenCalled();

  // A required cloud worker profile forces the embedded runtime, so it alone is compared.
  await commitGatewayConfigWrite({
    snapshot: writeSnapshot(cliModel("claude-cli")),
    writeOptions: {},
    nextConfig: { ...cliModel("claude-cli"), cloudWorkers: { requiredProfile: "fixture" } },
  });
  expect(billingMocks.collect).toHaveBeenCalledOnce();
});
