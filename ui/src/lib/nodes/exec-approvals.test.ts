import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import * as approvals from "./page-operations.ts";

const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
let state: ReturnType<typeof approvals.createInitialDevicesState>;
beforeEach(() => {
  request.mockReset();
  state = approvals.createInitialDevicesState({
    client: createTestGatewayClient(request),
    connected: true,
  });
});
const snapshot = (file: unknown = {}, hash = "original", path = "/synthetic/approvals") => ({
  path,
  exists: true,
  hash,
  file,
});
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
  request.mockResolvedValue(snapshot(file));
  await approvals.loadExecApprovals(state);
  expect(state.execApprovalsForm).toBe(file);
  const entryPath = ["agents", "main", "allowlist", 0];
  approvals.updateExecApprovalsFormValue(state, [...entryPath, "pattern"], "edited");
  const edited = state.execApprovalsForm;
  expect(edited?.agents?.main?.allowlist).toEqual([{ pattern: "edited" }, { pattern: "keep" }]);
  expect(edited?.defaults).toBe(file.defaults);
  expect(edited?.agents?.other).toBe(file.agents.other);
  expect(edited?.agents?.main?.allowlist?.[1]).toBe(second);
  approvals.removeExecApprovalsFormValue(state, entryPath);
  expect(state.execApprovalsForm?.agents?.main?.allowlist).toEqual([{ pattern: "keep" }]);
  expect(edited?.agents?.main?.allowlist).toHaveLength(2);
  const removed = state.execApprovalsForm;
  approvals.removeExecApprovalsFormValue(state, ["agents", "missing", "allowlist", 0]);
  approvals.updateExecApprovalsFormValue(state, ["version", "invalid"], true);
  approvals.updateExecApprovalsFormValue(state, [], undefined);
  expect(state.execApprovalsForm).toBe(removed);
  expect(state.execApprovalsDirty).toBe(true);
  expect(file.agents.main.allowlist).toEqual([{ pattern: "old" }, { pattern: "keep" }]);
});

it("keeps an edited policy on its original base when a refresh sees another writer", async () => {
  let hash = "original";
  request.mockImplementation(async () =>
    snapshot({ version: 1, defaults: { security: "deny" } }, hash),
  );
  await approvals.loadExecApprovals(state);
  approvals.updateExecApprovalsFormValue(state, ["defaults", "security"], "allowlist");
  hash = "another-writer";
  await approvals.loadExecApprovals(state);
  expect(state.execApprovalsSnapshot).toMatchObject({ hash: "original" });
  expect(state.execApprovalsForm?.defaults?.security).toBe("allowlist");
  await approvals.saveExecApprovals(state);
  expect(request).toHaveBeenCalledWith("exec.approvals.set", {
    baseHash: "original",
    file: { version: 1, defaults: { security: "allowlist" } },
  });
});

it("keeps native snapshots read-only", async () => {
  request.mockResolvedValue({
    enabled: true,
    hash: "sha256:current",
    defaultAction: "deny",
    rules: [{ pattern: "hostname", action: "allow" }],
  });
  const target = { kind: "node" as const, nodeId: "windows-node" };
  await approvals.loadExecApprovals(state, target);
  expect(state.execApprovalsForm).toBeNull();
  expect(state.execApprovalsDirty).toBe(false);
  approvals.updateExecApprovalsFormValue(state, ["defaults", "security"], "full");
  expect(state.execApprovalsDirty).toBe(false);
  expect(state.lastError).toContain("read-only");
  await approvals.saveExecApprovals(state, target);
  expect(request).toHaveBeenCalledTimes(1);
  expect(state.lastError).toContain("read-only");
});

it("isolates approval loads across a same-client reconnect", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const staleLoad = approvals.loadExecApprovals(state);
  state.requestGeneration += 2;
  state.execApprovalsLoading = false;
  const currentLoad = approvals.loadExecApprovals(state);
  first.resolve(snapshot({}, "old", "/old"));
  await staleLoad;
  expect(state.execApprovalsSnapshot).toBeNull();
  expect(state.execApprovalsLoading).toBe(true);
  const current = snapshot({}, "new", "/new");
  second.resolve(current);
  await currentLoad;
  expect(state.execApprovalsSnapshot).toEqual(current);
  expect(state.execApprovalsLoading).toBe(false);
});
