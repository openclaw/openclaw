import { expect, test, vi } from "vitest";
import { SessionStoreRegistryReadRequired } from "./session-sqlite-target.js";
import { readSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { resolveExistingAgentSessionStoreTargetsReadOnlyResult } from "./targets-read-availability.js";

vi.mock("./targets-read-availability.js", () => ({
  resolveExistingAgentSessionStoreTargetsReadOnlyResult: vi.fn(),
}));

test.each(["read-failed", "schema-missing", "database-missing"] as const)(
  "carries prior %s cleanup requirements through registry deferral",
  (reason) => {
    vi.mocked(resolveExistingAgentSessionStoreTargetsReadOnlyResult)
      .mockReturnValueOnce({ available: false, reason })
      .mockImplementationOnce(() => {
        throw new SessionStoreRegistryReadRequired();
      });
    expect(
      readSessionStoreTargetInventory({
        config: {},
        agentIds: ["main", "other"],
        env: {},
        paths: new Map(),
        candidates: [],
        registeredDatabases: { status: "deferred" },
      }),
    ).toEqual({
      kind: "session-target-registry-required",
      readFailed: reason !== "database-missing",
    });
  },
);
