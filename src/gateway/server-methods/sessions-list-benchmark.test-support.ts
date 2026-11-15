import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

type Benchmark = {
  rows: number;
  viewers: number;
  context: ReturnType<typeof requestContext>;
  clients: () => ReturnType<typeof identifiedClient>[];
  request: (client: ReturnType<typeof identifiedClient>) => ReturnType<typeof listSessions>;
  replaceLast: (label: string) => void;
};

export function withListBenchmark(
  mode: "cold" | "same" | "distinct",
  consume: (benchmark: Benchmark) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cold = mode === "cold";
    const rows = 5_000;
    const viewers = cold ? 6 : 25;
    const cfg = {
      agents: { entries: { main: {} } },
      ...(cold ? { plugins: { enabled: false } } : {}),
    };
    setRuntimeConfigSnapshot(cfg);
    const row = (index: number) => ({
      sessionId: `${cold ? "cold" : "list-bench"}-${index}`,
      updatedAt: index + 1,
      visibility: "shared" as const,
      ...(cold ? { label: `Synthetic conversation ${index} ${"context ".repeat(190)}` } : {}),
    });
    const target = (index: number) => ({
      agentId: "main",
      sessionKey: `agent:main:${cold ? "dashboard:cold" : "list-bench"}-${index}`,
    });
    runOpenClawAgentWriteTransaction(
      () => {
        for (let index = 0; index < rows; index++) {
          replaceSessionEntrySync(target(index), row(index));
        }
      },
      { agentId: "main" },
    );
    const release = retainSessionListForegroundWork();
    const context = requestContext(cfg);
    const clients = () =>
      Array.from({ length: viewers }, (_, index) => ({
        ...identifiedClient(cold ? "cold-viewer" : `viewer-${mode === "same" ? 0 : index}`),
        connId: `${cold ? "cold" : "list-bench"}-${index}`,
      }));
    try {
      await consume({
        rows,
        viewers,
        context,
        clients,
        request: (client) =>
          listSessions({
            context,
            client,
            acceptsSerializedJson: true,
            request: cold
              ? {
                  limit: 200,
                  rowMode: "compact",
                  source: "sidebar",
                  agentId: "main",
                  includeGlobal: true,
                  includeUnknown: true,
                  configuredAgentsOnly: true,
                }
              : { limit: 100, rowMode: "compact" },
          }),
        replaceLast: (label) =>
          replaceSessionEntrySync(target(rows - 1), { ...row(rows - 1), label }),
      });
    } finally {
      getSessionRowProjection(context)?.dispose();
      release();
    }
  });
}
