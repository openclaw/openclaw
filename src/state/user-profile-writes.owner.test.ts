import { expect, it, vi } from "vitest";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { prepareUserProfileCatalog } from "./user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  setCanonicalUserProfileDisplayName,
} from "./user-profile-writes.js";

vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: vi.fn(actual.runOpenClawStateWorkerOperation),
  };
});

it("reuses an ensured owner until a write receipt replaces its catalog row", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "owner-reuse-" });
  let release = () => {};
  try {
    const owner = await ensureCanonicalGatewayOwnerProfile("Host Person");
    release = (await prepareUserProfileCatalog()).release;
    await ensureCanonicalGatewayOwnerProfile("Host Person");
    vi.mocked(runOpenClawStateWorkerOperation).mockClear();
    const sql = observeMainThreadSql();
    const reused = await ensureCanonicalGatewayOwnerProfile("Host Person");
    expect(reused).toEqual(owner);
    expect(runOpenClawStateWorkerOperation).not.toHaveBeenCalled();
    sql.expectIdle();
    vi.restoreAllMocks();

    reused.displayName = "Caller mutation";
    expect((await ensureCanonicalGatewayOwnerProfile("Host Person")).displayName).toBe(
      "Host Person",
    );
    await setCanonicalUserProfileDisplayName(owner.id, "Saved Owner");
    expect((await ensureCanonicalGatewayOwnerProfile("Host Person")).displayName).toBe(
      "Saved Owner",
    );

    await setCanonicalUserProfileDisplayName(owner.id, null);
    await ensureCanonicalGatewayOwnerProfile(null);
    expect((await ensureCanonicalGatewayOwnerProfile("New Host Name")).displayName).toBe(
      "New Host Name",
    );
  } finally {
    vi.restoreAllMocks();
    release();
    await state.cleanup();
  }
});
