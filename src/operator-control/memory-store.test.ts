import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  listOperatorMemory,
  promoteOperatorMemory,
  upsertOperatorServiceContext,
} from "./memory-store.js";

describe("operator shared memory store", () => {
  it("promotes verified records and summarizes collection freshness", async () => {
    await withStateDirEnv("operator-memory-store-", async () => {
      const service = upsertOperatorServiceContext({
        service: "mission-control",
        summary: "Mission Control is primary operator surface",
        content: {
          owner: "tonya",
          mode: "authoritative-failover",
        },
        metadata: {
          source: "mission-control",
          writer: "tonya",
          evidence_ref: "task://bootstrap",
          verified_at: 1_700_000_000_000,
        },
      });

      const taskOutcome = promoteOperatorMemory({
        collection: "task-outcomes",
        record_id: "outcome-1",
        scope_key: "task-1",
        content: {
          task_id: "task-1",
          outcome: "success",
        },
        metadata: {
          source: "2tony",
          writer: "northstar",
          evidence_ref: "task://task-1",
          verified_at: 1_700_000_000_100,
        },
      });

      const snapshot = listOperatorMemory({ limit: 10 });
      expect(service.created).toBe(true);
      expect(taskOutcome.created).toBe(true);
      expect(snapshot.authority).toBe("local-json-shim");
      expect(snapshot.collections["service-context"]).toMatchObject({
        count: 1,
        lastVerifiedAt: 1_700_000_000_000,
        writeMode: "upsert",
      });
      expect(snapshot.collections["task-outcomes"]).toMatchObject({
        count: 1,
        lastVerifiedAt: 1_700_000_000_100,
        writeMode: "append-only",
      });
      expect(snapshot.records[0]?.collection).toBe("task-outcomes");
    });
  });

  it("dedupes append-only records and rejects stale upserts", async () => {
    await withStateDirEnv("operator-memory-store-guardrails-", async () => {
      const first = promoteOperatorMemory({
        collection: "channel-events",
        record_id: "event-1",
        scope_key: "discord:thread-1",
        content: {
          action: "nudge-review",
        },
        metadata: {
          source: "discord",
          writer: "deb",
          evidence_ref: "discord://thread-1",
          verified_at: 1_700_000_000_200,
        },
      });
      const duplicate = promoteOperatorMemory({
        collection: "channel-events",
        record_id: "event-1",
        scope_key: "discord:thread-1",
        content: {
          action: "nudge-review",
        },
        metadata: {
          source: "discord",
          writer: "deb",
          evidence_ref: "discord://thread-1",
          verified_at: 1_700_000_000_200,
        },
      });

      upsertOperatorServiceContext({
        service: "tonya",
        summary: "Tonya owns orchestration",
        content: {
          role: "primary",
        },
        metadata: {
          source: "control-plane",
          writer: "tonya",
          evidence_ref: "task://role-sync",
          verified_at: 1_700_000_000_300,
        },
      });

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(() =>
        upsertOperatorServiceContext({
          service: "tonya",
          summary: "Older stale note",
          content: {
            role: "unknown",
          },
          metadata: {
            source: "control-plane",
            writer: "tonya",
            evidence_ref: "task://stale",
            verified_at: 1_700_000_000_250,
          },
        }),
      ).toThrow("stale memory update rejected");
    });
  });
});
