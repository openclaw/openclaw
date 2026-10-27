import { expect, it, vi } from "vitest";
import type { SessionEntryListWorkerInput } from "./session-entry-read.types.js";
import type { SessionTranscriptWorkerRequest } from "./session-transcript-worker.types.js";

const observed = vi.hoisted(() => ({
  read: undefined as ((request: SessionTranscriptWorkerRequest) => Promise<unknown>) | undefined,
  enteredReader: 0,
}));

// mock-isolation: Capture dispatch without starting the real worker transport.
vi.mock("../../infra/worker-task-server.js", () => ({
  serveOwnedWorkerTasks: (read: typeof observed.read) => {
    observed.read = read;
  },
}));
// mock-isolation: Exercise command loading without opening retained database scopes.
vi.mock("./session-transcript-worker-scopes.js", () => ({
  withHistoryDatabase: async (_database: unknown, _operation: string, read: () => unknown) => ({
    ok: true,
    value: await read(),
  }),
  pruneClosedHistoryDatabaseScopes: () => {},
}));
// mock-isolation: Stop at the first reader boundary before database setup can warm imports.
vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: () => {
    // Stop at the database boundary: no query or fixture setup can warm the command graph.
    observed.enteredReader++;
    return { found: false, reason: "database-missing" };
  },
}));
// mock-isolation: Keep validation state isolated from the import-only dispatch probe.
vi.mock("../../state/openclaw-agent-db-validation-cache.js", () => ({
  releaseOpenClawAgentDatabaseReadValidation: () => {},
}));
// mock-isolation: Reject this heavy subtree; importing its real exports would warm the graph.
vi.mock("./session-history-read-operation.worker.js", () => {
  throw new Error("Recovery must not load history operations before its first query");
});
// mock-isolation: Reject this command-only subtree before the recovery reader is entered.
vi.mock("./session-transcript-read-fence.js", () => {
  throw new Error("Recovery must not load transcript read fences before its first query");
});
// mock-isolation: Reject general listing imports on the selected-row recovery path.
vi.mock("./session-accessor.sqlite-entry-list.read.js", () => {
  throw new Error("Recovery must not load general entry listing before its first query");
});

// Collection owns the shared worker bootstrap; command dependencies remain cold until dispatch.
import "./session-transcript.worker.js";

it("keeps unrelated command modules cold through saved-input and exec recovery reads", async () => {
  const scopes: SessionEntryListWorkerInput["scope"][] = [
    { agentId: "main", pendingInputRecovery: true },
    { agentId: "main", pendingExecRecovery: { limit: 64 } },
  ];
  for (const scope of scopes) {
    await expect(
      observed.read!({
        kind: "session-entry-list",
        database: { agentId: "main", path: "/synthetic/agent.sqlite" },
        scope,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "session-entry-list", entries: [] },
    });
  }
  expect(observed.enteredReader).toBe(2);
});
