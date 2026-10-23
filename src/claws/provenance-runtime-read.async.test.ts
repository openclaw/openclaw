import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import type { ClawInstallSchemaVersionRow } from "./provenance-runtime-read.kernel.js";

const worker = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ClawInstallSchemaVersionRow[] | undefined>>(),
  assertCurrent: vi.fn<() => void>(),
  lifecycle: vi.fn(),
}));

vi.mock("../state/openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db.js")>();
  return { ...actual, registerOpenClawStateDatabaseLifecycleListener: worker.lifecycle };
});

vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: worker.read,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: { assertCurrent: worker.assertCurrent },
  }),
}));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: () => {
    throw new Error("Consent preparation must not read SQLite on the main thread");
  },
}));

import * as provenance from "./provenance-runtime-read.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION as schemaVersion } from "./provenance-schema-version.js";

let pathSequence = 0;
let options: { path: string };
const row = { agentId: "worker", schemaVersion, agentConfigDigest: "original" };
function ready(agentConfigDigest?: string) {
  const read = { kind: "ok", schemaVersion: row.schemaVersion, agentConfigDigest };
  return { kind: "ready", schemaVersions: new Map(agentConfigDigest ? [["worker", read]] : []) };
}

const readSnapshot = (scope = options) => provenance.readCachedClawInstallSchemaVersions(scope);
const captureFacts = () =>
  structuredClone(provenance.captureClawInstallSchemaVersionFacts(options));
const closeDatabase = () =>
  worker.lifecycle.mock.calls[0]?.[0]({ kind: "closed", path: options.path });
async function publish() {
  (await provenance.prepareClawInstallSchemaVersions(options)).publish();
}

async function reloadSchemaVersions(rows: ClawInstallSchemaVersionRow[]) {
  closeDatabase();
  worker.read.mockResolvedValueOnce(rows);
  await publish();
}

beforeEach(() => {
  options = { path: `/claw-consent-preparation-${++pathSequence}.sqlite` };
  worker.assertCurrent.mockReset();
  worker.read.mockReset().mockResolvedValue([row]);
});

it("isolates handed-off facts from newer host facts and expires their scope", async () => {
  await publish();
  const facts = captureFacts();
  await reloadSchemaVersions([{ ...row, agentConfigDigest: "newer" }]);
  const current = readSnapshot();
  worker.read.mockClear();
  let readAfterScope = readSnapshot;
  await provenance.withClawInstallSchemaVersionFacts(facts, async () => {
    const captured = AsyncLocalStorage.snapshot();
    readAfterScope = () => captured(readSnapshot);
    for (let tick = 0; tick < 5; tick++) {
      expect(readSnapshot()).toEqual(ready("original"));
      await Promise.resolve();
    }
    expect(() => readSnapshot({ path: `${options.path}-other` })).toThrow(
      "outside their captured state scope",
    );
  });
  expect(readAfterScope).toThrow("outside their captured state scope");
  expect(readSnapshot()).toBe(current);
  expect(worker.read).not.toHaveBeenCalled();
});

it.each(["uninitialized", "state-error", "invalid-row"] as const)(
  "preserves %s through the worker handoff without rediscovering ownership",
  async (state) => {
    if (state === "state-error") {
      await publish();
      closeDatabase();
      worker.read.mockRejectedValueOnce(new Error("Unreadable provenance"));
      await publish();
    } else if (state === "invalid-row") {
      worker.read.mockResolvedValueOnce([{ ...row, schemaVersion: "unsupported" }]);
      await publish();
    }
    const facts = captureFacts();
    worker.read.mockClear();
    await provenance.withClawInstallSchemaVersionFacts(facts, async () => {
      const snapshot = readSnapshot();
      expect(snapshot.kind).toBe(state === "invalid-row" ? "ready" : state);
      if (snapshot.kind === "ready") {
        expect(snapshot.schemaVersions.get("worker")).toMatchObject({ kind: "error" });
      } else if (snapshot.kind === "state-error") {
        expect(snapshot).toMatchObject({
          error: "Unreadable provenance",
          knownAgentIds: new Set(["worker"]),
        });
      }
    });
    expect(worker.read).not.toHaveBeenCalled();
  },
);

it.each(["update", "delete"] as const)(
  "stages privately and preserves a reloaded %s until closure without synchronous reads",
  async (mutation) => {
    const prepared = await provenance.prepareClawInstallSchemaVersions(options);
    expect(readSnapshot()).toEqual({ kind: "uninitialized" });
    prepared.publish();
    expect(readSnapshot()).toEqual(ready("original"));
    const stale = await provenance.prepareClawInstallSchemaVersions(options);
    await reloadSchemaVersions(
      mutation === "update" ? [{ ...row, agentConfigDigest: "newer" }] : [],
    );
    const current = readSnapshot();
    stale.publish();
    expect(readSnapshot()).toBe(current);
    expect(current).toEqual(ready(mutation === "update" ? "newer" : undefined));
    await publish();
    expect(readSnapshot()).toBe(current);
    expect(worker.read).toHaveBeenCalledTimes(2);
    const listener = worker.lifecycle.mock.calls[0]?.[0];
    listener({ kind: "opened", database: { path: options.path } });
    expect(readSnapshot()).toBe(current);
    closeDatabase();
    await publish();
    expect(worker.read).toHaveBeenCalledTimes(3);
    expect(readSnapshot()).toEqual(ready("original"));
  },
);

it("fails closed if database admission expires before publication", async () => {
  await publish();
  const prepared = await provenance.prepareClawInstallSchemaVersions(options);
  const error = new Error("Database admission expired");
  worker.assertCurrent.mockImplementation(() => {
    throw error;
  });
  prepared.publish();
  expect(readSnapshot()).toEqual({
    kind: "state-error",
    error,
    knownAgentIds: new Set(["worker"]),
    ownershipUnknown: true,
  });
});
