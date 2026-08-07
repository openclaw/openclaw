const CHANNEL_ID = "qa-health-hook-deadline";
const DELAY_MS = 6_000;

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
    mode: config.mode ?? "delayed",
  };
}

const plugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "QA Health Hook Deadline",
    selectionLabel: "QA Health Hook Deadline",
    docsPath: "/gateway/health",
    blurb: "Isolated QA fixture for bounded channel health hooks.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(channelConfig(cfg).accounts ?? {}),
    defaultAccountId: (cfg) => Object.keys(channelConfig(cfg).accounts ?? {})[0] ?? "default",
    resolveAccount,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
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
      probe,
    }),
    buildChannelSummary: ({ account }) => ({ qaMode: account.mode }),
  },
};

export default {
  id: CHANNEL_ID,
  register(api) {
    api.registerChannel({ plugin });
  },
};
