import path from "node:path";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";

const DEADLINE_PLUGIN_ID = "qa-health-hook-deadline";
const DEADLINE_CHANNEL_ID = "qa-health-hook-deadline";
const DEADLINE_ACCOUNT_IDS = Array.from({ length: 6 }, (_, index) => `account-${index + 1}`);
const GATEWAY_TRACE_MAX_CHARS = 8_000;

export const HEALTH_HOOK_DEADLINE_ACCOUNT_COUNT = DEADLINE_ACCOUNT_IDS.length;

type AccountState = {
  skipped?: boolean;
  timedOut?: boolean;
};

export type HealthHookDeadlineProof = {
  delayedCli: {
    accountCount: number;
    durationMs: number;
    gatewayTrace: string;
    skippedCount: number;
    timedOutCount: number;
  };
  hangingRpc: {
    firstDurationMs: number;
    firstSkippedCount: number;
    firstTimedOutCount: number;
    gatewayTrace: string;
    secondDurationMs: number;
    secondSkippedCount: number;
    secondTimedOutCount: number;
  };
};

export function resolveHealthHookDeadlineFixturePluginDir(
  repoRoot = path.resolve(import.meta.dirname, "../../../.."),
) {
  return path.join(repoRoot, "test/e2e/qa-lab/runtime/fixtures/health-hook-deadline-plugin");
}

export function withHealthHookDeadlineFixture(
  config: OpenClawConfig,
  pluginDir: string,
  mode: "delayed" | "hanging-probe",
): OpenClawConfig {
  return {
    ...config,
    channels: {
      ...config.channels,
      [DEADLINE_CHANNEL_ID]: {
        enabled: true,
        mode,
        accounts: Object.fromEntries(
          DEADLINE_ACCOUNT_IDS.map((accountId) => [accountId, { enabled: true }]),
        ),
      },
    },
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), DEADLINE_PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [DEADLINE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected record, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function readHealthAccounts(payload: unknown): Record<string, AccountState> {
  const channels = asRecord(asRecord(payload).channels);
  const channel = asRecord(channels[DEADLINE_CHANNEL_ID]);
  const accounts = asRecord(channel.accounts);
  return Object.fromEntries(
    Object.entries(accounts).map(([accountId, state]) => [
      accountId,
      asRecord(state) as AccountState,
    ]),
  );
}

function countAccountState(accounts: Record<string, AccountState>, key: "skipped" | "timedOut") {
  return Object.values(accounts).filter((account) => account[key] === true).length;
}

function boundedGatewayTrace(logs: string) {
  return logs.slice(-GATEWAY_TRACE_MAX_CHARS);
}

async function runDelayedHealthHookCliProof(repoRoot: string, pluginDir: string) {
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot,
      useRepoCli: true,
      transportBaseUrl: "http://127.0.0.1",
      providerMode: "mock-openai",
      controlUiEnabled: false,
      // This status-only fixture has no channel runtime; RPC startup is still verified.
      allowUnhealthyStartup: true,
      mutateConfig: (config) => withHealthHookDeadlineFixture(config, pluginDir, "delayed"),
    });
    const startedAt = Date.now();
    const stdout = await gateway.runCli(["health", "--verbose", "--json"]);
    const durationMs = Date.now() - startedAt;
    const accounts = readHealthAccounts(JSON.parse(stdout));
    return {
      accountCount: Object.keys(accounts).length,
      durationMs,
      gatewayTrace: boundedGatewayTrace(gateway.logs()),
      skippedCount: countAccountState(accounts, "skipped"),
      timedOutCount: countAccountState(accounts, "timedOut"),
    };
  } catch (error) {
    const trace = gateway ? boundedGatewayTrace(gateway.logs()) : "Gateway did not start";
    throw new Error(`delayed health CLI proof failed: ${String(error)}\nGateway trace:\n${trace}`, {
      cause: error,
    });
  } finally {
    await gateway?.stop().catch(() => undefined);
  }
}

async function runHangingHealthHookRpcProof(repoRoot: string, pluginDir: string) {
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot,
      useRepoCli: true,
      transportBaseUrl: "http://127.0.0.1",
      providerMode: "mock-openai",
      controlUiEnabled: false,
      // This status-only fixture has no channel runtime; RPC startup is still verified.
      allowUnhealthyStartup: true,
      mutateConfig: (config) => withHealthHookDeadlineFixture(config, pluginDir, "hanging-probe"),
    });
    const firstStartedAt = Date.now();
    const first = await gateway.call("health", { probe: true }, { timeoutMs: 20_000 });
    const firstDurationMs = Date.now() - firstStartedAt;
    const firstAccounts = readHealthAccounts(first);

    const secondStartedAt = Date.now();
    const second = await gateway.call("health", { probe: true }, { timeoutMs: 20_000 });
    const secondDurationMs = Date.now() - secondStartedAt;
    const secondAccounts = readHealthAccounts(second);

    return {
      firstDurationMs,
      firstSkippedCount: countAccountState(firstAccounts, "skipped"),
      firstTimedOutCount: countAccountState(firstAccounts, "timedOut"),
      gatewayTrace: boundedGatewayTrace(gateway.logs()),
      secondDurationMs,
      secondSkippedCount: countAccountState(secondAccounts, "skipped"),
      secondTimedOutCount: countAccountState(secondAccounts, "timedOut"),
    };
  } catch (error) {
    const trace = gateway ? boundedGatewayTrace(gateway.logs()) : "Gateway did not start";
    throw new Error(`hanging health RPC proof failed: ${String(error)}\nGateway trace:\n${trace}`, {
      cause: error,
    });
  } finally {
    await gateway?.stop().catch(() => undefined);
  }
}

export async function runHealthHookDeadlineProof(
  repoRoot = path.resolve(import.meta.dirname, "../../../.."),
): Promise<HealthHookDeadlineProof> {
  const pluginDir = resolveHealthHookDeadlineFixturePluginDir(repoRoot);
  return {
    delayedCli: await runDelayedHealthHookCliProof(repoRoot, pluginDir),
    hangingRpc: await runHangingHealthHookRpcProof(repoRoot, pluginDir),
  };
}
