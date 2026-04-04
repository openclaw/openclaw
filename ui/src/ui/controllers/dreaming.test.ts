import { describe, expect, it, vi } from "vitest";
import { loadDreamingStatus, updateDreamingMode, type DreamingState } from "./dreaming.ts";

function createState(): { state: DreamingState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: DreamingState = {
    client: {
      request,
    } as unknown as DreamingState["client"],
    connected: true,
    configSnapshot: { hash: "hash-1" },
    applySessionKey: "main",
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: null,
    dreamingModeSaving: false,
    lastError: null,
  };
  return { state, request };
}

describe("dreaming controller", () => {
  it("loads and normalizes dreaming status from doctor.memory.status", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      dreaming: {
        mode: "rem",
        enabled: true,
        frequency: "0 */6 * * *",
        timezone: "America/Los_Angeles",
        limit: 10,
        minScore: 0.85,
        minRecallCount: 4,
        minUniqueQueries: 3,
        shortTermCount: 8,
        promotedTotal: 21,
        promotedToday: 2,
        managedCronPresent: true,
        nextRunAtMs: 12345,
      },
    });

    await loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    expect(state.dreamingStatus).toEqual(
      expect.objectContaining({
        mode: "rem",
        enabled: true,
        shortTermCount: 8,
        promotedToday: 2,
        managedCronPresent: true,
        nextRunAtMs: 12345,
      }),
    );
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("patches config to update dreaming mode", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ ok: true });

    const ok = await updateDreamingMode(state, "deep");

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        baseHash: "hash-1",
        sessionKey: "main",
      }),
    );
    expect(state.dreamingModeSaving).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("fails gracefully when config hash is missing", async () => {
    const { state, request } = createState();
    state.configSnapshot = {};

    const ok = await updateDreamingMode(state, "core");

    expect(ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.dreamingStatusError).toContain("Config hash missing");
  });
});
