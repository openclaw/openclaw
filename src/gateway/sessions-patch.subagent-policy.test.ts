import { describe, expect, test } from "vitest";
import { expectPatchOk, runPatch } from "./sessions-patch.test-support.js";

describe("sessions patch subagent tool policy", () => {
  test.each([
    { source: "scheduled-run" as const, kept: undefined },
    { source: "sender" as const, kept: "sender" },
  ])(
    "drops a run's spawn mark, never a sender restriction, with a patched ceiling ($source)",
    async ({ source, kept }) => {
      const storeKey = "agent:main:subagent:child";
      const marked = {
        sessionId: "child",
        updatedAt: 1,
        inheritedToolPolicySource: source,
        inheritedToolPolicyRunSessionKey: "agent:main:cron:nightly:run:r1",
      };
      const entry = expectPatchOk(
        await runPatch({
          storeKey,
          store: { [storeKey]: marked },
          patch: { key: storeKey, inheritedToolDeny: ["exec"] },
        }),
      );
      expect(entry.inheritedToolPolicySource).toBe(kept);
      expect(entry.inheritedToolPolicyRunSessionKey).toBeUndefined();
    },
  );
});
