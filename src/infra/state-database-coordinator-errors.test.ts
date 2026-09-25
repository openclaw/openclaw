import { expect, it } from "vitest";
import { StateDatabaseCoordinatorContentionError } from "./state-database-coordinator-errors.js";

it.each(["state-lifecycle", "gateway-lifecycle", "state-handles"] as const)(
  "explains %s contention and preserves holder diagnostics",
  (family) => {
    const owner = { pid: 1234, startTime: 5678, command: "openclaw", family };
    for (const blockingOwner of [undefined, owner]) {
      const error = new StateDatabaseCoordinatorContentionError(family, blockingOwner);
      expect(error.family).toBe(family);
      expect(error.blockingOwner).toBe(blockingOwner);
      expect(error.message).toContain(`OpenClaw state database is busy (${family}).`);
      expect(error.message).toContain("Wait for the other OpenClaw process to finish, then retry.");
      expect(error.message).toContain(
        "If it persists, run `openclaw gateway status` and check for other OpenClaw processes using the same state directory.",
      );
      expect(error.message.includes("A running Gateway can hold this lock until it stops")).toBe(
        family !== "state-lifecycle",
      );
      if (blockingOwner) {
        expect(error.message).toContain(`holder=${JSON.stringify(owner)}`);
      }
    }
  },
);
