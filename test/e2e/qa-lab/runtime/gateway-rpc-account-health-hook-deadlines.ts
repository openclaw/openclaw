import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";

const DEADLINE_PLUGIN_ID = "qa-health-hook-deadline";
const DEADLINE_CHANNEL_ID = "qa-health-hook-deadline";
const DEADLINE_ACCOUNT_IDS = Array.from({ length: 6 }, (_, index) => `account-${index + 1}`);
const DEADLINE_DELAY_MS = 6_000;
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
    firstStartedTimedOutCount: number;
    firstTimedOutCount: number;
    gatewayTrace: string;
    secondDurationMs: number;
    secondSkippedCount: number;
    secondStartedTimedOutCount: number;
    secondTimedOutCount: number;
  };
};

export async function createHealthHookDeadlineFixturePlugin() {
  // openclaw-temp-dir: the producer removes this standalone fixture root in its finally block
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-health-hook-deadline-"));
  const pluginDir = path.join(root, DEADLINE_PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: DEADLINE_PLUGIN_ID,
        activation: { onStartup: true },
        channels: [DEADLINE_CHANNEL_ID],
        channelConfigs: {
          [DEADLINE_CHANNEL_ID]: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                mode: { type: "string", enum: ["delayed", "hanging-probe"] },
                accounts: { type: "object", additionalProperties: true },
              },
            },
          },
        },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `const CHANNEL_ID = ${JSON.stringify(DEADLINE_CHANNEL_ID)};
const DELAY_MS = ${DEADLINE_DELAY_MS};
let activeProbes = 0;
let maxActiveProbes = 0;

function channelConfig(cfg) {
  return cfg?.channels?.[CHANNEL_ID] ?? {};
}

function resolveAccount(cfg, accountId) {
  const config = channelConfig(cfg);
  const accountConfig = config.accounts?.[accountId] ?? {};
  return {
    accountId,
    configured: true,
    enabled: config.enabled !== false && accountConfig.enabled !== false,
    mode: config.mode ?? "delayed"
  };
}

const plugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "QA Health Hook Deadline",
    selectionLabel: "QA Health Hook Deadline",
    docsPath: "/gateway/health",
    blurb: "Isolated QA fixture for bounded channel health hooks."
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(channelConfig(cfg).accounts ?? {}),
    defaultAccountId: (cfg) => Object.keys(channelConfig(cfg).accounts ?? {})[0] ?? "default",
    resolveAccount,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled
  },
  status: {
    probeAccount: async ({ account }) => {
      if (account.mode === "hanging-probe") {
        await new Promise(() => {});
      }
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      try {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        return { ok: true, delayMs: DELAY_MS, maxActiveProbes };
      } finally {
        activeProbes -= 1;
      }
    },
    buildAccountSnapshot: ({ account, probe }) => ({
      accountId: account.accountId,
      configured: account.configured,
      enabled: account.enabled,
      probe
    }),
    buildChannelSummary: ({ account }) => ({ qaMode: account.mode })
  }
};

module.exports = {
  id: CHANNEL_ID,
  register(api) {
    api.registerChannel({ plugin });
  }
};
`,
    "utf8",
  );
  return { pluginDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
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

function countStartedTimeouts(accounts: Record<string, AccountState>) {
  return Object.values(accounts).filter(
    (account) => account.timedOut === true && account.skipped !== true,
  ).length;
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
      firstStartedTimedOutCount: countStartedTimeouts(firstAccounts),
      firstTimedOutCount: countAccountState(firstAccounts, "timedOut"),
      gatewayTrace: boundedGatewayTrace(gateway.logs()),
      secondDurationMs,
      secondSkippedCount: countAccountState(secondAccounts, "skipped"),
      secondStartedTimedOutCount: countStartedTimeouts(secondAccounts),
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
  const fixture = await createHealthHookDeadlineFixturePlugin();
  try {
    return {
      delayedCli: await runDelayedHealthHookCliProof(repoRoot, fixture.pluginDir),
      hangingRpc: await runHangingHealthHookRpcProof(repoRoot, fixture.pluginDir),
    };
  } finally {
    await fixture.cleanup();
  }
}
