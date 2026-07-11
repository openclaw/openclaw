import { describe, expect, it, vi } from "vitest";
import {
  createInitialNodesState,
  loadExecApprovals,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./index.ts";

describe("host-native exec approvals state", () => {
  it("keeps native snapshots read-only", async () => {
    const request = vi.fn().mockResolvedValue({
      enabled: true,
      hash: "sha256:current",
      defaultAction: "deny",
      rules: [{ pattern: "hostname", action: "allow" }],
    });
    const state = createInitialNodesState({ client: { request }, connected: true });
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
});
