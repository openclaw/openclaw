// @vitest-environment node
import { expect, it, vi } from "vitest";
import { sessionsResult } from "./session-capability.test-support.ts";
import { sessionRow, sessionRpcHarness } from "./session-rpc.test-support.ts";

// mock-isolation: Simulate a failed chunk download without initializing or registering its runtime.
vi.mock("./session-mutation-operations.runtime.ts", () => {
  throw new Error("Synthetic mutation runtime download failure");
});

it("fails before patch dispatch and restores its preview when the optional runtime cannot load", async () => {
  const row = sessionRow("rename", { label: "Original label" });
  const h = sessionRpcHarness({
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.list": () => sessionsResult([row]),
    "sessions.patch": () => ({ ok: true, key: row.key, entry: { ...row, label: "New label" } }),
  });
  await h.sessions.refresh({ agentId: "main" });
  const patch = h.sessions.patch(
    row.key,
    { label: "New label" },
    { expectedSessionId: row.sessionId },
  );
  expect(h.sessions.state.result?.sessions[0]?.label).toBe("New label");
  await expect(patch).rejects.toThrow();
  expect(h.request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
  expect(h.sessions.state.result?.sessions[0]?.label).toBe("Original label");
});
