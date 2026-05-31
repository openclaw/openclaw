// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  loadExecApprovals,
  saveExecApprovals,
  updateExecApprovalsFormValue,
  type ExecApprovalsState,
} from "./exec-approvals.ts";

function createState(request: ReturnType<typeof vi.fn>): ExecApprovalsState {
  return {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    lastError: null,
  };
}

describe("exec approvals controller", () => {
  it("keeps host-native node approval snapshots read-only", async () => {
    const request = vi.fn(async () => ({
      enabled: true,
      defaultAction: "deny",
      hash: "native-hash",
      rules: [{ pattern: "echo *", action: "allow", enabled: true }],
    }));
    const state = createState(request);

    await loadExecApprovals(state, { kind: "node", nodeId: "node-1" });

    expect(request).toHaveBeenCalledWith("exec.approvals.node.get", { nodeId: "node-1" });
    expect(state.execApprovalsSnapshot).toEqual({
      enabled: true,
      defaultAction: "deny",
      hash: "native-hash",
      rules: [{ pattern: "echo *", action: "allow", enabled: true }],
    });
    expect(state.execApprovalsForm).toBeNull();
    expect(state.execApprovalsDirty).toBe(false);

    updateExecApprovalsFormValue(state, ["defaults", "security"], "full");

    expect(state.execApprovalsForm).toBeNull();
    expect(state.execApprovalsDirty).toBe(false);
    expect(state.lastError).toContain("read-only");

    await saveExecApprovals(state, { kind: "node", nodeId: "node-1" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.lastError).toContain("read-only");
  });
});
