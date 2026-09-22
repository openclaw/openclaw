import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawInstallSchemaVersionRow } from "./provenance-runtime-read.kernel.js";

const worker = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ClawInstallSchemaVersionRow[] | undefined>>(),
  assertCurrent: vi.fn<() => void>(),
}));

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

import {
  cacheClawInstallSchemaVersion,
  captureClawInstallSchemaVersionFacts,
  deleteCachedClawInstallSchemaVersion,
  initializeCachedClawInstallSchemaVersions,
  prepareClawInstallSchemaVersions,
  readCachedClawInstallSchemaVersions,
  withClawInstallSchemaVersionFacts,
} from "./provenance-runtime-read.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";

let pathSequence = 0;
let options: { path: string };
const row = {
  agentId: "worker",
  schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
  agentConfigDigest: "original",
};

beforeEach(() => {
  options = { path: `/claw-consent-preparation-${++pathSequence}.sqlite` };
  worker.assertCurrent.mockReset();
  worker.read.mockReset().mockResolvedValue([row]);
});

describe("asynchronous Claw consent preparation", () => {
  it("hands off one task's facts without replacing newer host facts or retaining the scope", async () => {
    (await prepareClawInstallSchemaVersions(options)).publish();
    const facts = structuredClone(captureClawInstallSchemaVersionFacts(options));
    cacheClawInstallSchemaVersion("worker", row.schemaVersion, "newer", options);
    const current = readCachedClawInstallSchemaVersions(options);
    worker.read.mockClear();
    let readAfterScope = () => readCachedClawInstallSchemaVersions(options);
    await withClawInstallSchemaVersionFacts(facts, async () => {
      const captured = AsyncLocalStorage.snapshot();
      readAfterScope = () => captured(() => readCachedClawInstallSchemaVersions(options));
      for (let tick = 0; tick < 5; tick++) {
        initializeCachedClawInstallSchemaVersions(options);
        expect(readCachedClawInstallSchemaVersions(options)).toEqual({
          kind: "ready",
          schemaVersions: new Map([
            [
              "worker",
              { kind: "ok", schemaVersion: row.schemaVersion, agentConfigDigest: "original" },
            ],
          ]),
        });
        await Promise.resolve();
      }
      expect(() =>
        initializeCachedClawInstallSchemaVersions({ path: `${options.path}-other` }),
      ).toThrow("outside their captured state scope");
    });
    expect(readAfterScope).toThrow("outside their captured state scope");
    expect(readCachedClawInstallSchemaVersions(options)).toBe(current);
    expect(worker.read).not.toHaveBeenCalled();
    await withClawInstallSchemaVersionFacts(
      structuredClone(captureClawInstallSchemaVersionFacts(options)),
      async () => expect(readCachedClawInstallSchemaVersions(options)).toEqual(current),
    );
  });

  it.each(["uninitialized", "state-error", "invalid-row"] as const)(
    "preserves %s through the worker handoff without rediscovering ownership",
    async (state) => {
      if (state === "state-error") {
        (await prepareClawInstallSchemaVersions(options)).publish();
        worker.read.mockRejectedValueOnce(new Error("Unreadable provenance"));
        (await prepareClawInstallSchemaVersions(options)).publish();
      } else if (state === "invalid-row") {
        worker.read.mockResolvedValueOnce([{ ...row, schemaVersion: "unsupported" }]);
        (await prepareClawInstallSchemaVersions(options)).publish();
      }
      const facts = structuredClone(captureClawInstallSchemaVersionFacts(options));
      worker.read.mockClear();
      await withClawInstallSchemaVersionFacts(facts, async () => {
        initializeCachedClawInstallSchemaVersions(options);
        const snapshot = readCachedClawInstallSchemaVersions(options);
        if (state === "invalid-row") {
          expect(snapshot.kind).toBe("ready");
          if (snapshot.kind === "ready") {
            expect(snapshot.schemaVersions.get("worker")).toMatchObject({ kind: "error" });
          }
        } else {
          expect(snapshot).toMatchObject(
            state === "uninitialized"
              ? { kind: "uninitialized" }
              : {
                  kind: "state-error",
                  error: "Unreadable provenance",
                  knownAgentIds: new Set(["worker"]),
                },
          );
        }
      });
      expect(worker.read).not.toHaveBeenCalled();
    },
  );

  it("keeps worker rows private until publication without synchronous SQLite reads", async () => {
    const prepared = await prepareClawInstallSchemaVersions(options);
    expect(readCachedClawInstallSchemaVersions(options)).toEqual({ kind: "uninitialized" });

    prepared.publish();

    expect(readCachedClawInstallSchemaVersions(options)).toEqual({
      kind: "ready",
      schemaVersions: new Map([
        ["worker", { kind: "ok", schemaVersion: row.schemaVersion, agentConfigDigest: "original" }],
      ]),
    });
  });

  it.each(["update", "delete"] as const)(
    "keeps a newer committed %s when an older read publishes",
    async (mutation) => {
      (await prepareClawInstallSchemaVersions(options)).publish();
      const stale = await prepareClawInstallSchemaVersions(options);
      if (mutation === "update") {
        cacheClawInstallSchemaVersion("worker", row.schemaVersion, "newer", options);
      } else {
        deleteCachedClawInstallSchemaVersion("worker", options);
      }
      const current = readCachedClawInstallSchemaVersions(options);

      stale.publish();

      expect(readCachedClawInstallSchemaVersions(options)).toBe(current);
      expect(current).toEqual({
        kind: "ready",
        schemaVersions:
          mutation === "update"
            ? new Map([
                [
                  "worker",
                  { kind: "ok", schemaVersion: row.schemaVersion, agentConfigDigest: "newer" },
                ],
              ])
            : new Map(),
      });
    },
  );

  it("fails closed if database admission expires before publication", async () => {
    (await prepareClawInstallSchemaVersions(options)).publish();
    const prepared = await prepareClawInstallSchemaVersions(options);
    const error = new Error("Database admission expired");
    worker.assertCurrent.mockImplementation(() => {
      throw error;
    });

    prepared.publish();

    expect(readCachedClawInstallSchemaVersions(options)).toEqual({
      kind: "state-error",
      error,
      knownAgentIds: new Set(["worker"]),
      ownershipUnknown: true,
    });
  });

  it("does not let an obsolete failed read poison a newer consent snapshot", async () => {
    (await prepareClawInstallSchemaVersions(options)).publish();
    worker.read.mockRejectedValueOnce(new Error("Read failed"));
    const failed = await prepareClawInstallSchemaVersions(options);
    cacheClawInstallSchemaVersion("worker", row.schemaVersion, "newer", options);
    const current = readCachedClawInstallSchemaVersions(options);

    failed.publish();

    expect(readCachedClawInstallSchemaVersions(options)).toBe(current);
    expect(current.kind).toBe("ready");
  });
});
