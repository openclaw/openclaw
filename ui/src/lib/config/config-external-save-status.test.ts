import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createConfigExternalSaveStatus } from "./config-external-save-status.ts";
import {
  createInitialConfigState,
  currentConfigConnectionEpoch,
  type RuntimeConfigState,
} from "./config-state-model.ts";

function setup() {
  const client = {} as GatewayBrowserClient;
  const state: RuntimeConfigState = { ...createInitialConfigState(), client, connected: true };
  const publish = vi.fn();
  const status = createConfigExternalSaveStatus(state, publish);
  const saveStatus = { retry: vi.fn(async () => undefined), discard: vi.fn() };
  return { client, state, publish, status, saveStatus };
}

describe("config external save status", () => {
  it("reports Saving while the write runs and a saved receipt after it", async () => {
    const { client, state, status, saveStatus } = setup();
    const receipts = state.configSaveReceipts;
    const task = status.track(
      async () => {
        expect(state.configAutoSaveStatus).toBe("saving");
        return "value";
      },
      { saveStatus },
    );
    expect(await task(client)).toBe("value");
    status.settle(
      { ok: true, value: "value", refresh: { ok: true } },
      { saveStatus },
      client,
      currentConfigConnectionEpoch(state),
    );
    expect(state.configAutoSaveStatus).toBe("saved");
    expect(state.configSaveReceipts).toBe(receipts + 1);
  });

  it("leaves writes that didn't ask for it alone", async () => {
    const { client, state, status } = setup();
    state.configAutoSaveStatus = "idle";
    await status.track(async () => undefined, {})(client);
    status.settle(
      { ok: false, reason: "error", error: "nope" },
      {},
      client,
      currentConfigConnectionEpoch(state),
    );
    expect(state.configAutoSaveStatus).toBe("idle");
    expect(state.lastError).toBeNull();
    expect(status.retry()).toBeNull();
  });

  it("recovers a failed write through its owner", async () => {
    const { client, state, status, saveStatus } = setup();
    const epoch = currentConfigConnectionEpoch(state);
    status.settle(
      { ok: false, reason: "error", error: "disk full" },
      { saveStatus },
      client,
      epoch,
    );
    expect(state.configAutoSaveStatus).toBe("error");
    expect(state.lastError).toBe("disk full");

    await status.retry();
    expect(saveStatus.retry).toHaveBeenCalledTimes(1);
    expect(state.lastError).toBeNull();
    expect(status.retry()).toBeNull();

    status.settle({ ok: false, reason: "rejected", error: "bad" }, { saveStatus }, client, epoch);
    expect(state.configAutoSaveStatus).toBe("rejected");
    const clearPatches = vi.fn();
    status.discard(clearPatches);
    expect(clearPatches).toHaveBeenCalledTimes(1);
    expect(saveStatus.discard).toHaveBeenCalledTimes(1);
    expect(status.retry()).toBeNull();
  });

  it("says nothing was attempted when the write never started", () => {
    const { client, state, status, saveStatus } = setup();
    state.configAutoSaveStatus = "saving";
    status.settle(
      { ok: false, reason: "unavailable", error: "offline" },
      { saveStatus },
      client,
      currentConfigConnectionEpoch(state),
    );
    expect(state.configAutoSaveStatus).toBe("idle");
    expect(state.lastError).toBeNull();
    expect(status.retry()).toBeNull();
  });
});
