import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-failed-redispatch",
  agentId: "main",
  sessionKey: "agent:main:failed-redispatch",
};

describe("failed worker placement redispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-redispatch-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("continues a committed dispatch after its real worker reply is corrupted", async () => {
    const receive = brokerReply.receiveSqliteWorkerReply;
    let corrupted = 0;
    vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const value: unknown = deserialize(reply.value);
        if (
          isRecord(value) &&
          value.sessionId === SESSION.sessionId &&
          value.state === "requested"
        ) {
          corrupted += 1;
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
        }
      }
      return receive(slot, reply, owner);
    });
    const placement = await store.startDispatch(SESSION);
    expect(corrupted).toBe(1);
    expect(placement).toEqual(store.get(SESSION.sessionId));
    expect(
      await store.transition({
        sessionId: SESSION.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: "environment-after-lost-reply" },
      }),
    ).toMatchObject({ state: "provisioning", generation: placement.generation + 1 });
  });

  it.each(["replaced", "cleanup", "claim", "move"] as const)(
    "rechecks the complete %s source in the redispatch transaction",
    async (scenario) => {
      const executionMode = scenario === "claim" ? "remote-exec" : "worker-turn";
      const active = await advancePlacementFixtureToActive(store, database, {
        ...SESSION,
        executionMode,
      });
      if (scenario === "claim") {
        await store.claimTurn({
          ...SESSION,
          claimId: "previous-turn",
          runId: "previous-run",
          owner: placementTurnOwner(active),
        });
      } else if (scenario === "move") {
        await store.beginPlacementMove({
          sessionId: SESSION.sessionId,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "gateway" },
        });
      }
      if (scenario === "claim") {
        // Older failed rows can retain a local claim without weakening today's drain contract.
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(`UPDATE worker_session_placements SET state = 'failed',
              transition_generation = transition_generation + 3,
              recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
              terminal_at_ms = 1 WHERE session_id = ?`).run(SESSION.sessionId);
          },
          { database },
        );
      } else {
        const draining =
          scenario === "move"
            ? store.get(SESSION.sessionId)
            : await store.startDrain({
                sessionId: SESSION.sessionId,
                environmentId: active.environmentId,
                ownerEpoch: active.activeOwnerEpoch,
                expectedGeneration: active.generation,
              });
        if (draining?.state !== "draining") {
          throw new Error("expected draining worker placement");
        }
        const reconciling = await store.startReconcile({
          sessionId: SESSION.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        });
        await store.fail({
          sessionId: SESSION.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError: "worker stopped",
        });
      }
      const failed = store.get(SESSION.sessionId);
      if (failed?.state !== "failed") {
        throw new Error("expected failed worker placement");
      }
      writePlacementEnvironmentFixture(database, {
        environmentId: active.environmentId,
        state: scenario === "cleanup" ? "destroying" : "destroyed",
        ownerEpoch: active.activeOwnerEpoch + 1,
        attachedSessionIds: [],
      });
      if (scenario === "replaced") {
        const replacement = await store.startDispatch({ ...SESSION, executionMode });
        await store.fail({
          sessionId: SESSION.sessionId,
          expectedGeneration: replacement.generation,
          recoveryError: "replacement failed",
        });
      }
      const before = store.get(SESSION.sessionId);
      const dispatch = store.startDispatch({
        ...SESSION,
        executionMode,
        expectedPlacement: failed,
      });
      await expect(dispatch).rejects.toThrow(
        scenario === "replaced" || scenario === "claim"
          ? "changed before redispatch"
          : scenario === "cleanup"
            ? "still requires recovery"
            : "pending workspace recovery",
      );
      expect(store.get(SESSION.sessionId)).toEqual(before);
    },
  );
});
