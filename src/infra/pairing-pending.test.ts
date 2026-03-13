import { describe, expect, it, vi } from "vitest";
import { rejectPendingPairingRequest } from "./pairing-pending.js";

describe("rejectPendingPairingRequest", () => {
  it("returns null and skips persistence when the request is missing", async () => {
    const persistState = vi.fn();

    await expect(
      rejectPendingPairingRequest({
        requestId: "missing",
        idKey: "deviceId",
        loadState: async () => ({ pendingById: {} }),
        persistState,
        getId: (pending: { id: string }) => pending.id,
      }),
    ).resolves.toBeNull();

    expect(persistState).not.toHaveBeenCalled();
  });

  it("removes the request, persists, and returns the dynamic id key", async () => {
    const state = {
      pendingById: {
        keep: { accountId: "keep-me" },
        reject: { accountId: "acct-42" },
      },
    } satisfies {
      pendingById: Record<string, { accountId: string }>;
    };
    const persistState = vi.fn(async () => undefined);

    await expect(
      rejectPendingPairingRequest({
        requestId: "reject",
        idKey: "accountId",
        loadState: async () => state,
        persistState,
        getId: (pending: { accountId: string }) => pending.accountId,
      }),
    ).resolves.toEqual({
      requestId: "reject",
      accountId: "acct-42",
    });

    expect(state.pendingById).toEqual({
      keep: { accountId: "keep-me" },
    });
    expect(persistState).toHaveBeenCalledWith(state);
  });
});
