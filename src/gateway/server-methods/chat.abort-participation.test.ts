import { describe, expect, it, vi } from "vitest";
import * as abortDescendants from "./chat-abort-descendants.js";
import { stopReservedClientRun } from "./chat-abort-exact-run.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";

// An invited participant's Stop (#204899) ends the reserved turn but leaves the session's subagents.
describe("chat.abort participation", () => {
  it.each([
    { participationOnly: true, stopsSubagents: false },
    { participationOnly: undefined, stopsSubagents: true },
  ])(
    "stops a reserved run's subagents only for a full requester: participationOnly=$participationOnly",
    async ({ participationOnly, stopsSubagents }) => {
      const reserved = createActiveRun("main", {
        runId: "reserved-run",
        agentId: "main",
        storeScope: "/synthetic/chat-abort/session-controller.sqlite",
      });
      using descendants = vi.spyOn(abortDescendants, "abortControlledSubagents");
      const result = await stopReservedClientRun({
        cfg: {},
        runId: "reserved-run",
        reserved: reserved.input,
        identity: { sessionKey: "main", sessionId: "main-session", agentId: "main" },
        agentId: "main",
        participationOnly,
        assertCurrent: () => {},
        hookContext: { commandSource: "gateway:chat.abort" },
      });
      expect(result.aborted).toBe(true);
      expect(reserved.input.abortSignal.aborted).toBe(true);
      expect(descendants).toHaveBeenCalledTimes(stopsSubagents ? 1 : 0);
    },
  );
});
