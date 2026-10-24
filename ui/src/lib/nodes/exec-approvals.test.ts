import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createInitialDevicesState,
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./page-operations.ts";

describe("host-native exec approvals state", () => {
  it("copies only the edited policy path and keeps earlier receipts immutable", async () => {
    const first = Object.freeze({ pattern: "old" });
    const second = Object.freeze({ pattern: "keep" });
    const file = Object.freeze({
      version: 1,
      defaults: Object.freeze({ security: "deny" }),
      agents: Object.freeze({
        main: Object.freeze({ allowlist: Object.freeze([first, second]) }),
        other: Object.freeze({ security: "allowlist" }),
      }),
    });
    const request = vi.fn().mockResolvedValue({
      path: "/synthetic/approvals",
      exists: true,
      hash: "original",
      file,
    });
    const state = createInitialDevicesState({ client: { request }, connected: true });
    await loadExecApprovals(state);
    expect(state.execApprovalsForm).toBe(file);

    updateExecApprovalsFormValue(state, ["agents", "main", "allowlist", 0, "pattern"], "edited");
    const edited = state.execApprovalsForm;
    expect(edited?.agents?.main?.allowlist).toEqual([{ pattern: "edited" }, { pattern: "keep" }]);
    expect(edited?.defaults).toBe(file.defaults);
    expect(edited?.agents?.other).toBe(file.agents.other);
    expect(edited?.agents?.main?.allowlist?.[1]).toBe(second);
    expect(first.pattern).toBe("old");

    removeExecApprovalsFormValue(state, ["agents", "main", "allowlist", 0]);
    expect(state.execApprovalsForm?.agents?.main?.allowlist).toEqual([{ pattern: "keep" }]);
    expect(edited?.agents?.main?.allowlist).toHaveLength(2);
    const removed = state.execApprovalsForm;
    removeExecApprovalsFormValue(state, ["agents", "missing", "allowlist", 0]);
    updateExecApprovalsFormValue(state, ["version", "invalid"], true);
    updateExecApprovalsFormValue(state, [], undefined);
    expect(state.execApprovalsForm).toBe(removed);
    expect(state.execApprovalsDirty).toBe(true);
    expect(file.agents.main.allowlist).toEqual([{ pattern: "old" }, { pattern: "keep" }]);
  });

  it("keeps an edited policy on its original base when a refresh sees another writer", async () => {
    let hash = "original";
    const request = vi.fn().mockImplementation(async () => ({
      path: "/synthetic/approvals",
      exists: true,
      hash,
      file: { version: 1, defaults: { security: "deny" } },
    }));
    const state = createInitialDevicesState({ client: { request }, connected: true });
    await loadExecApprovals(state);
    updateExecApprovalsFormValue(state, ["defaults", "security"], "allowlist");
    hash = "another-writer";
    await loadExecApprovals(state);
    expect(state.execApprovalsSnapshot).toMatchObject({ hash: "original" });
    expect(state.execApprovalsForm?.defaults?.security).toBe("allowlist");
    await saveExecApprovals(state);
    expect(request).toHaveBeenCalledWith("exec.approvals.set", {
      baseHash: "original",
      file: { version: 1, defaults: { security: "allowlist" } },
    });
  });

  it("keeps native snapshots read-only", async () => {
    const request = vi.fn().mockResolvedValue({
      enabled: true,
      hash: "sha256:current",
      defaultAction: "deny",
      rules: [{ pattern: "hostname", action: "allow" }],
    });
    const state = createInitialDevicesState({ client: { request }, connected: true });
    const target = { kind: "node" as const, nodeId: "windows-node" };

    await loadExecApprovals(state, target);

    expect(state.execApprovalsForm).toBeNull();
    expect(state.execApprovalsDirty).toBe(false);
    updateExecApprovalsFormValue(state, ["defaults", "security"], "full");
    expect(state.execApprovalsDirty).toBe(false);
    expect(state.lastError).toContain("read-only");

    await saveExecApprovals(state, target);

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.lastError).toContain("read-only");
  });

  it("isolates approval loads across a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const state = createInitialDevicesState({ client, connected: true });

    const staleLoad = loadExecApprovals(state);
    state.connected = false;
    state.requestGeneration += 1;
    state.execApprovalsLoading = false;
    state.connected = true;
    state.requestGeneration += 1;
    const currentLoad = loadExecApprovals(state);

    first.resolve({ path: "/old", exists: true, hash: "old", file: {} });
    await staleLoad;
    expect(state.execApprovalsSnapshot).toBeNull();
    expect(state.execApprovalsLoading).toBe(true);

    const current = { path: "/new", exists: true, hash: "new", file: {} };
    second.resolve(current);
    await currentLoad;
    expect(state.execApprovalsSnapshot).toEqual(current);
    expect(state.execApprovalsLoading).toBe(false);
  });
});
