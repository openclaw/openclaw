import { mockNativeModuleExports } from "../../test/helpers/native-module-mock.js";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const count = 150_000;
const storePath = "/mock/agents/main/agent/openclaw-agent.sqlite";
const unexpected = () => {
  throw new Error("unexpected non-preview dependency");
};
const beforeStore = Object.fromEntries(
  Array.from({ length: count }, (_, i) => [
    `agent:main:label-${i}`,
    { sessionId: `session-${i}`, updatedAt: 1, model: "gpt-5.6-luna", label: `label-${i}` },
  ]),
);
let serviceCalls = 0;

// Keep the actual command, grid, and label-summary owners. Only fixture the
// service and unrelated metadata boundaries; no large database is needed.
mockNativeModuleExports(new URL(`../config/config.${extension}`, import.meta.url), {
  getRuntimeConfig: () => ({}),
});
mockNativeModuleExports(new URL(`./session-store-targets.${extension}`, import.meta.url), {
  resolveCommandSessionStoreTargets: () => [{ agentId: "main", storePath }],
});
mockNativeModuleExports(new URL(`../config/sessions.${extension}`, import.meta.url), {
  resolveSessionCleanupAction: () => "keep",
  isSessionsCleanupPartialResult: unexpected,
  serializeSessionCleanupResult: unexpected,
  runSessionsCleanup: async () => {
    serviceCalls += 1;
    return {
      mode: "warn",
      appliedSummaries: [],
      previewResults: [
        {
          summary: {
            agentId: "main",
            storePath,
            mode: "warn",
            dryRun: true,
            beforeCount: count,
            afterCount: count,
            missing: 0,
            dmScopeRetired: 0,
            modelRunPruned: 0,
            pruned: 0,
            capped: 0,
            diskBudget: null,
            wouldMutate: false,
          },
          beforeStore,
          missingKeys: new Set(),
          modelRunPrunedKeys: new Set(),
          archivedKeys: new Set(),
          staleKeys: new Set(),
          cappedKeys: new Set(),
          dmScopeRetiredKeys: new Set(),
        },
      ],
    };
  },
});
mockNativeModuleExports(new URL(`../gateway/call.${extension}`, import.meta.url), {
  buildGatewayConnectionDetails: unexpected,
  callGateway: unexpected,
  isImplicitLocalGatewayTarget: unexpected,
});
mockNativeModuleExports(
  new URL(`../gateway/call-mutation-fallback.${extension}`, import.meta.url),
  {
    resolveGatewayMutationFallback: unexpected,
  },
);
mockNativeModuleExports(
  new URL(`../config/sessions/session-sqlite-target.${extension}`, import.meta.url),
  {
    resolveSqliteTargetFromSessionStorePath: () => ({ path: storePath }),
  },
);
mockNativeModuleExports(new URL(`./sessions-display-model.${extension}`, import.meta.url), {
  resolveSessionDisplayModelRef: (_cfg: unknown, row: { model: string }) => ({
    model: row.model,
  }),
});

const { sessionsCleanupCommand } = await import("./sessions-cleanup.js");
let gridPrinted = false;
let summaryPrinted = false;
let labelRows = 0;
let total = "";
await sessionsCleanupCommand(
  { dryRun: true, store: storePath },
  {
    log: (value: unknown) => {
      const line = String(value);
      if (line.includes("Action") && line.includes("Flags")) {
        gridPrinted = true;
      }
      if (line === "Summary by Label:") {
        summaryPrinted = true;
      }
      if (/^label-\d+ +1 kept, 0 pruned$/u.test(line)) {
        labelRows += 1;
      }
      if (line.startsWith("Total:")) {
        total = line;
      }
    },
    error: unexpected,
    exit: unexpected,
  },
);
console.log(JSON.stringify({ serviceCalls, gridPrinted, summaryPrinted, labelRows, total }));
