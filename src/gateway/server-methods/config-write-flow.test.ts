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
