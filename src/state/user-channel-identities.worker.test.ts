import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { listUserChannelIdentitiesInDatabase } from "./user-channel-identities.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const { options } = useProfileDatabase("channel-admission-");

it.each(
  (["transaction", "commit"] as const).flatMap((stage) =>
    (["retry", "exhaust", "revoke"] as const).map((outcome) => ({ stage, outcome })),
  ),
)("releases the WAL after withheld $stage admission before $outcome", ({ stage, outcome }) => {
  const profile = ensureProfileForEmail("owner@example.test", options);
  const database = openOpenClawStateDatabase(options);
  using checkpoint = new DatabaseSync(options.path);
  checkpoint.exec("PRAGMA busy_timeout = 0");
  const wal = checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
  const assertCheckpoint = () => expect(wal.get()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
  const links = checkpoint.prepare("SELECT 1 FROM user_profile_identities WHERE provider=?");
  const identity = { channelId: "discord", accountId: "test-bot", senderId: "1234" };
  let now = process.hrtime.bigint();
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const counts = { attempts: 0, withheld: 0, checkpoints: 0 };
  let pendingStage: unknown;
  const admission = operationAdmission.createSqliteWorkerOperationAdmission((_request, grant) => {
    if (outcome === "revoke" && counts.attempts > 1) {
      throw new Error("Channel administrator authority was revoked");
    }
    grant();
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => admission.finish());
  const postMessage = admission.port.postMessage.bind(admission.port);
  vi.spyOn(admission.port, "postMessage").mockImplementation((message, transferList) => {
    if (isRecord(message) && (message.stage === "transaction" || message.stage === "commit")) {
      pendingStage = message.stage;
    }
    if (isRecord(message) && message.stage === "transaction") {
      counts.attempts += 1;
      expect(database.db.isTransaction).toBe(false);
    }
    postMessage(message, transferList);
  });
  vi.spyOn(Atomics, "wait").mockImplementation((_decision, _index, _value, timeout) => {
    expect(typeof timeout === "number" && timeout > 0 && timeout <= 1_000).toBe(true);
    if (pendingStage === "transaction" && counts.attempts > 1) {
      expect(links.all("channel.identity")).toEqual([]);
      assertCheckpoint();
      counts.checkpoints += 1;
    }
    if (pendingStage === stage && (outcome === "exhaust" || counts.attempts === 1)) {
      expect(database.db.isTransaction).toBe(stage === "commit");
      counts.withheld += 1;
      now += 1_000_000_000n;
      return "timed-out";
    }
    admission.service();
    return "ok";
  });
  const change = () =>
    operationAdmission.withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      executeUserChannelIdentityChange(
        { action: "link", profileId: profile.id, identity },
        { ...options, database },
      ),
    );
  if (outcome === "retry") {
    expect(change()).toMatchObject({ ok: true, value: { kind: "linked" } });
  } else {
    expect(change).toThrow(
      outcome === "exhaust"
        ? "Channel identity link could not obtain database admission after 3 attempts. Check `openclaw gateway status --deep`, then retry the operation."
        : "SQLite transaction admission was refused",
    );
    if (outcome === "revoke") {
      expect(admission.failure).toEqual(new Error("Channel administrator authority was revoked"));
    }
  }
  expect(listUserChannelIdentitiesInDatabase(database.db, profile.id)).toEqual(
    outcome === "retry" ? [{ profileId: profile.id, identity }] : [],
  );
  expect(Object.values(counts)).toEqual(outcome === "exhaust" ? [3, 3, 2] : [2, 1, 1]);
  expect(database.db.isTransaction).toBe(false);
  assertCheckpoint();
});
