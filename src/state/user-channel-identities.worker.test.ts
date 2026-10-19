import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { listUserChannelIdentitiesInDatabase } from "./user-channel-identities.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each(
  (["transaction", "commit"] as const).flatMap((stage) =>
    (["retry", "exhaust", "revoke"] as const).map((outcome) => ({ stage, outcome })),
  ),
)("releases the WAL after withheld $stage admission before $outcome", ({ stage, outcome }) => {
  const options = { path: join(tempDirs.make("channel-admission-"), "state.sqlite") };
  const profile = ensureProfileForEmail("owner@example.test", options);
  const database = openOpenClawStateDatabase(options);
  const checkpoint = new DatabaseSync(options.path);
  checkpoint.exec("PRAGMA busy_timeout = 0");
  const identity = { channelId: "discord", accountId: "test-bot", senderId: "1234" };
  let now = process.hrtime.bigint();
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  let attempts = 0;
  let withheld = 0;
  let checkpoints = 0;
  let pendingStage: unknown;
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    if (outcome === "revoke" && attempts > 1) {
      throw new Error("Channel administrator authority was revoked");
    }
    grant();
  });
  const postMessage = admission.port.postMessage.bind(admission.port);
  vi.spyOn(admission.port, "postMessage").mockImplementation((message, transferList) => {
    if (isRecord(message) && (message.stage === "transaction" || message.stage === "commit")) {
      pendingStage = message.stage;
    }
    if (isRecord(message) && message.stage === "transaction") {
      attempts += 1;
      expect(database.db.isTransaction).toBe(false);
    }
    postMessage(message, transferList);
  });
  vi.spyOn(Atomics, "wait").mockImplementation((_decision, _index, _value, timeout) => {
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1_000);
    if (pendingStage === "transaction" && attempts > 1) {
      expect(
        checkpoint
          .prepare("SELECT * FROM user_profile_identities WHERE provider = 'channel.identity'")
          .all(),
      ).toEqual([]);
      expect(checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
        busy: 0,
        log: 0,
        checkpointed: 0,
      });
      checkpoints += 1;
    }
    if (pendingStage === stage && (outcome === "exhaust" || attempts === 1)) {
      expect(database.db.isTransaction).toBe(stage === "commit");
      withheld += 1;
      now += 1_000_000_000n;
      return "timed-out";
    }
    admission.service();
    return "ok";
  });
  const change = () =>
    withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      executeUserChannelIdentityChange(
        { action: "link", profileId: profile.id, identity },
        { ...options, database },
      ),
    );
  try {
    if (outcome === "retry") {
      expect(change()).toMatchObject({ ok: true, value: { kind: "linked" } });
      expect(listUserChannelIdentitiesInDatabase(database.db, profile.id)).toEqual([
        { profileId: profile.id, identity },
      ]);
      expect(attempts).toBe(2);
      expect(withheld).toBe(1);
    } else {
      expect(change).toThrow(
        outcome === "exhaust"
          ? "Channel identity link could not obtain database admission after 3 attempts. Check `openclaw gateway status --deep`, then retry the operation."
          : "SQLite transaction admission was refused",
      );
      if (outcome === "revoke") {
        expect(admission.failure).toEqual(new Error("Channel administrator authority was revoked"));
      }
      expect(listUserChannelIdentitiesInDatabase(database.db, profile.id)).toEqual([]);
      expect(attempts).toBe(outcome === "exhaust" ? 3 : 2);
      expect(withheld).toBe(outcome === "exhaust" ? 3 : 1);
    }
    expect(checkpoints).toBe(attempts - 1);
    expect(database.db.isTransaction).toBe(false);
    expect(checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
      busy: 0,
      log: 0,
      checkpointed: 0,
    });
  } finally {
    admission.finish();
    checkpoint.close();
  }
});
