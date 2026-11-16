import { mockNativeModuleExports } from "../../test/helpers/native-module-mock.js";
import { cleanupSummary } from "./sessions-cleanup-summary.test-support.js";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const mock = (module: string, exports: Record<string, unknown>) =>
  mockNativeModuleExports(new URL(`${module}.${extension}`, import.meta.url), exports);
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

// Exercise the real grid and label summary without allocating a 150k-row database.
mock("../config/config", {
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
});
mock("./session-store-targets", {
  resolveCommandSessionStoreTargets: () => [{ agentId: "main", storePath }],
});
mock("../config/sessions", {
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
          summary: cleanupSummary({ storePath, beforeCount: count, afterCount: count }),
          beforeStore,
        },
      ],
    };
  },
});
mock("../gateway/call", {
  buildGatewayConnectionDetails: unexpected,
  callGateway: unexpected,
  isImplicitLocalGatewayTarget: unexpected,
});
mock("../gateway/call-mutation-fallback", { resolveGatewayMutationFallback: unexpected });
mock("../config/sessions/session-sqlite-target", {
  resolveSqliteTargetFromSessionStorePath: () => ({ path: storePath }),
});
mock("./sessions-display-model", {
  resolveSessionDisplayModelRef: (_cfg: unknown, row: { model: string }) => ({ model: row.model }),
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
      gridPrinted ||= line.includes("Action") && line.includes("Flags");
      summaryPrinted ||= line === "Summary by Label:";
      labelRows += Number(/^label-\d+ +1 kept, 0 pruned$/u.test(line));
      if (line.startsWith("Total:")) {
        total = line;
      }
    },
    error: unexpected,
    exit: unexpected,
  },
);
console.log(JSON.stringify({ serviceCalls, gridPrinted, summaryPrinted, labelRows, total }));
