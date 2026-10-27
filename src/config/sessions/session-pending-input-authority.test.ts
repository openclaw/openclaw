import { expect, it } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  withCurrentPendingInputAuthority,
  type SessionPendingInputAuthority,
} from "./session-pending-input-authority.js";

it("joins initiated writes when authority reader cleanup fails", async () => {
  const writeError = new SqliteWorkerError("Accepted write outcome is unknown", "outcome-unknown");
  const accepted = Promise.reject(writeError);
  void accepted.catch(() => {});
  const authority: SessionPendingInputAuthority = {
    assertLifetimeCurrent() {},
    async withCurrent(consume) {
      consume(
        {
          agentId: "main",
          storePath: "/synthetic/agent.sqlite",
          sessionKey: "main",
          entry: undefined,
          members: [],
        },
        () => {},
      );
      throw new Error("Reader cleanup failed after initiation");
    },
    withPreparedCurrent: (_facts, consume) => consume(),
  };
  await expect(
    withCurrentPendingInputAuthority(
      [authority],
      () => {},
      () => accepted,
    ),
  ).rejects.toBe(writeError);
});
