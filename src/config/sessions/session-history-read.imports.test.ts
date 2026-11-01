import { expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";
import type { SessionTranscriptWorkerRequest } from "./session-transcript-worker.types.js";

const paths = (prefix: string, names: string) =>
  names.split(" ").map((name) => `${prefix}${name}.ts`);
const sessions = (names: string) => paths("src/config/sessions/session-", names);
const gateway = (names: string) => paths("src/gateway/", names);
const configIO = paths("src/config/", "io io.runtime");
const aiTransports = "packages/ai/src/transports.ts";

it.each([
  ["transport", sessions("transcript-worker-runtime"), configIO],
  [
    "title and topology",
    [
      ...gateway("session-transcript-title-reader.worker"),
      "src/config/sessions/combined-store-topology.worker.ts",
    ],
    [...configIO, ...sessions("accessor")],
  ],
  [
    "history acquisition and decoration",
    [
      ...sessions("transcript.worker accessor.sqlite-branches"),
      ...gateway(
        "session-history-readonly-reader session-transcript-preview-reader chat-history-page-kernel session-history-snapshot",
      ),
    ],
    [
      ...sessions(
        "accessor.sqlite-scope accessor.sqlite-active-projection accessor.sqlite-delta accessor.sqlite-history-events transcript-reconcile",
      ),
      ...paths(
        "src/state/",
        "openclaw-agent-db openclaw-agent-db-lifecycle openclaw-agent-db-readonly openclaw-state-db",
      ),
      ...gateway("current-user-profile-display session-transcript-message session-utils.fs"),
    ],
  ],
  [
    "lazy runtime",
    gateway("session-history-worker-reader"),
    [
      ...gateway("session-utils-store-sources"),
      ...sessions("store-target-inventory"),
      "src/config/runtime-source-projection.ts",
      "src/agents/bash-tools.process-schema.ts",
      "packages/tool-call-repair/src/stream-normalizer.ts",
    ],
  ],
  [
    "lazy entry readers",
    [
      ...gateway("session-history-worker-reader"),
      ...sessions("store-target-inventory entry-read.worker accessor.sqlite-model-context"),
    ],
    [
      "src/config/sessions/lifecycle.ts",
      ...sessions(
        "accessor accessor.sqlite-entry-store accessor.sqlite-read accessor.sqlite-exact-read",
      ),
      aiTransports,
      "packages/ai/src/internal/default-runtime.ts",
      "packages/gateway-protocol/src/schema/users.ts",
    ],
  ],
  [
    "usage",
    ["src/infra/session-cost-usage-worker.ts"],
    [...configIO, ...sessions("accessor"), aiTransports],
  ],
  [
    "exact entry mutation",
    sessions("accessor.transcript-target entry-read-result.worker"),
    sessions("accessor.entry accessor.sqlite-entry"),
  ],
] as const)("keeps the %s import boundary", (_name, roots, forbidden) => {
  expect(findSourceImportBackedges(roots, forbidden)).toEqual([]);
});

const prewarm = vi.hoisted(() => ({
  read: vi.fn<(input: SessionTranscriptWorkerRequest) => Promise<unknown>>(),
  modules: Array.from({ length: 4 }, () => vi.fn(() => ({}))),
  startup: undefined as { prewarmHistory: true } | undefined,
  loadsAtRegistration: [] as number[],
  open: vi.fn(() => ({ found: false, reason: "database-missing" })),
}));

// mock-isolation: Each module load represents one new worker's startup data.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get workerData() {
    return prewarm.startup;
  },
}));
// mock-isolation: Capture dispatch without installing native worker ports in the test process.
vi.mock("../../infra/worker-task-server.js", () => ({
  serveOwnedWorkerTasks(handler: (input: SessionTranscriptWorkerRequest) => Promise<unknown>) {
    prewarm.loadsAtRegistration = prewarm.modules.map((loaded) => loaded.mock.calls.length);
    prewarm.read.mockImplementation(handler);
  },
}));
// mock-isolation: Native custody has separate real-database proof; this test owns import timing.
vi.mock("./session-transcript-worker-scopes.js", () => ({
  withHistoryDatabase: async (_database: unknown, _operation: string, read: () => unknown) => ({
    ok: true,
    value: await read(),
  }),
  pruneClosedHistoryDatabaseScopes: () => {},
}));
// mock-isolation: Missing-store admission isolates startup imports from actual database handles.
vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: prewarm.open,
}));

it.each([false, true])(
  "prepares presentation before serving only for foreground history workers (foreground=%s)",
  async (foreground) => {
    vi.resetModules();
    prewarm.startup = foreground ? { prewarmHistory: true } : undefined;
    prewarm.modules.forEach((loaded) => loaded.mockClear());
    prewarm.open.mockClear();
    // mock-isolation: Fresh workers have independent module caches and no previous warm request.
    vi.doMock("../../gateway/session-history-worker-reader.js", () => prewarm.modules[0]!());
    // mock-isolation: Observe each fresh worker's presentation imports without loading the kernel.
    vi.doMock("../../gateway/chat-history-page-kernel.js", () => prewarm.modules[1]!());
    // mock-isolation: Observe each fresh worker's presentation imports without loading response code.
    vi.doMock("../../gateway/chat-history-response-page.js", () => prewarm.modules[2]!());
    // mock-isolation: Observe each fresh worker's presentation imports without loading snapshot code.
    vi.doMock("../../gateway/session-history-snapshot.js", () => prewarm.modules[3]!());
    await import("./session-transcript.worker.js");
    expect(prewarm.loadsAtRegistration).toEqual(Array(4).fill(Number(foreground)));
    // Missing stores are allowed; database admission still runs independently of code preparation.
    await expect(
      prewarm.read({
        kind: "prewarm",
        env: {},
        database: { agentId: "main", path: "/synthetic/missing/openclaw-agent.sqlite" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "prewarm" },
    });
    expect(prewarm.open).toHaveBeenCalledOnce();
    for (const loaded of prewarm.modules) {
      expect(loaded).toHaveBeenCalledTimes(Number(foreground));
    }
  },
);
