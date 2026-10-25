import { expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";
import type { SessionTranscriptWorkerRequest } from "./session-transcript-worker.types.js";

function expectIndependent(...args: Parameters<typeof findSourceImportBackedges>) {
  expect(findSourceImportBackedges(...args)).toEqual([]);
}
const files = (prefix: string, groups: string[]) =>
  groups
    .join(" ")
    .split(" ")
    .map((name) => `${prefix}${name}.ts`);
const sessionFiles = (...groups: string[]) => files("src/config/sessions/session-", groups);
const gatewayFiles = (...groups: string[]) => files("src/gateway/", groups);
const configIO = ["src/config/io.ts", "src/config/io.runtime.ts"];

it("keeps history worker transport independent of host config loading", () => {
  expectIndependent(sessionFiles("transcript-worker-runtime"), configIO);
});

it("keeps transcript title and topology workers independent of host config loading", () => {
  expectIndependent(
    [
      ...gatewayFiles("session-transcript-title-reader.worker"),
      "src/config/sessions/combined-store-topology.worker.ts",
    ],
    [...configIO, ...sessionFiles("accessor")],
  );
});

const readOwners = [
  ...sessionFiles("transcript.worker accessor.sqlite-branches"),
  ...gatewayFiles(
    "session-history-readonly-reader session-transcript-preview-reader",
    "chat-history-page-kernel session-history-snapshot",
  ),
];

it("keeps history readers independent of host acquisition and decoration", () => {
  expectIndependent(readOwners, [
    ...sessionFiles(
      "accessor.sqlite-scope accessor.sqlite-active-projection accessor.sqlite-delta",
      "accessor.sqlite-history-events transcript-reconcile",
    ),
    "src/state/openclaw-agent-db.ts",
    "src/state/openclaw-agent-db-lifecycle.ts",
    "src/state/openclaw-agent-db-readonly.ts",
    "src/state/openclaw-state-db.ts",
    ...gatewayFiles("current-user-profile-display session-transcript-message session-utils.fs"),
  ]);
});

it("keeps lazy readers independent of unrelated runtime barrels", () => {
  expectIndependent(gatewayFiles("session-history-worker-reader"), [
    ...gatewayFiles("session-utils-store-sources"),
    ...sessionFiles("store-target-inventory"),
    "src/config/runtime-source-projection.ts",
  ]);
  expectIndependent(
    [
      ...gatewayFiles("session-history-worker-reader"),
      ...sessionFiles("store-target-inventory entry-read.worker accessor.sqlite-model-context"),
    ],
    [
      "src/config/sessions/lifecycle.ts",
      ...sessionFiles(
        "accessor accessor.sqlite-entry-store accessor.sqlite-read accessor.sqlite-exact-read",
      ),
      "packages/ai/src/transports.ts",
      "packages/ai/src/internal/default-runtime.ts",
      "packages/gateway-protocol/src/schema/users.ts",
    ],
  );
  expectIndependent("src/infra/session-cost-usage-worker.ts", [
    ...configIO,
    ...sessionFiles("accessor"),
    "packages/ai/src/transports.ts",
  ]);
});

it("keeps transcript target and exact-entry readers independent of entry mutation facades", () => {
  expect(
    findSourceImportBackedges(
      [
        "src/config/sessions/session-accessor.transcript-target.ts",
        "src/config/sessions/session-entry-read-result.worker.ts",
      ],
      [
        "src/config/sessions/session-accessor.entry.ts",
        "src/config/sessions/session-accessor.sqlite-entry.ts",
      ],
    ),
  ).toEqual([]);
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
