/* @vitest-environment jsdom */

import { assert, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolvePlacementComposer } from "./chat-pane-placement.ts";

function placementSession(
  state: NonNullable<GatewaySessionRow["placement"]>["state"],
  recoveryAction?: "restart" | "stop-first",
): GatewaySessionRow {
  return {
    key: "agent:main:cloud",
    kind: "direct",
    updatedAt: 0,
    placement: {
      state,
      ...(recoveryAction ? { recoveryAction } : {}),
    } as GatewaySessionRow["placement"],
  };
}

function presentation(
  row: GatewaySessionRow,
  overrides: Partial<Parameters<typeof resolvePlacementComposer>[0]> = {},
) {
  return resolvePlacementComposer({
    gatewaySnapshot: {
      hello: {
        features: { methods: ["sessions.dispatch", "sessions.reclaim"] },
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      },
    } as ApplicationGatewaySnapshot,
    movingKey: null,
    reclaimingKey: null,
    restartingKey: null,
    row,
    startupPending: false,
    workspaceResultReconciling: false,
    onRecover: vi.fn(),
    onReclaim: vi.fn(),
    ...overrides,
  });
}

describe("chat placement composer presentation", () => {
  it("projects provisioning placement into a setup composer", () => {
    expect(presentation(placementSession("provisioning"))).toMatchObject({
      state: { kind: "setup" },
      blocksSend: false,
      busyMessage: null,
    });
  });

  it("changes only the sync hint for current required worker inference", () => {
    const row = placementSession("active");
    Object.assign(row.placement!, { profileId: "coding", inference: "worker" });
    const original = presentation(row, { workspaceResultReconciling: true });
    const result = presentation(row, {
      workspaceResultReconciling: true,
      requiredWorkerInferenceProfileId: "coding",
    });
    expect(result).toEqual({ ...original, busyMessage: null });
    expect(result.blocksSend).toBe(false);
    expect(result.state.kind).toBe("busy");
  });

  it.each([
    { state: "syncing", operation: "placementMove", message: "Finishing session move…" },
    { state: "draining", message: "Finishing session move…" },
    { state: "failed", operation: "reclaimingKey", message: "Stopping session…" },
  ] as const)("blocks sync sends during $state $operation", ({ state, message, ...scenario }) => {
    const row = placementSession(state);
    Object.assign(row.placement!, { profileId: "coding", inference: "worker" });
    if (row.placement?.state === "failed") {
      row.placement.recoveryAction = "restart";
      row.placement.retryOnSend = true;
    }
    const operation = "operation" in scenario ? scenario.operation : undefined;
    if (operation === "placementMove") {
      row.placementMove = { target: { kind: "gateway" }, updatedAtMs: 1 };
    }
    const result = presentation(row, {
      workspaceResultReconciling: true,
      requiredWorkerInferenceProfileId: "coding",
      ...(operation && operation !== "placementMove" ? { [operation]: row.key } : {}),
    });

    expect(result.blocksSend).toBe(true);
    expect(result.busyMessage).toBe(message);
  });

  it("blocks a repository-only session with local placement and offers worker dispatch", () => {
    const onRecover = vi.fn();
    const row: GatewaySessionRow = {
      ...placementSession("local"),
      key: "agent:main:repository",
      repositoryWorkspaceId: "repository-workspace-1",
      placement: {
        state: "local",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      },
    };

    const result = presentation(row, { onRecover });

    expect(result).toMatchObject({
      state: { kind: "dispatch-required" },
      blocksSend: true,
      disabledBanner: { title: "Repository worker required", actionLabel: "Choose worker…" },
    });
    expect(result.state).toEqual({ kind: "dispatch-required" });
    assert(result.disabledBanner?.onAction);
    result.disabledBanner.onAction();
    expect(onRecover).toHaveBeenCalledOnce();
  });

  it("projects failed stop-first recovery into an actionable composer banner", () => {
    const onReclaim = vi.fn();
    const row = placementSession("failed", "stop-first");
    Object.assign(row.placement!, { profileId: "coding" });
    const result = presentation(row, { onReclaim });

    expect(result.state).toEqual({ kind: "failed", recoveryAction: "stop-first" });
    expect(result).toMatchObject({
      blocksSend: true,
      disabledBanner: { title: "Runner failed", actionLabel: "Stop cloud worker…" },
    });
    assert(result.disabledBanner?.onAction);
    result.disabledBanner.onAction();
    expect(onReclaim).toHaveBeenCalledOnce();
  });

  it("requires recovery authority even when a failed worker retains its profile", () => {
    const row = placementSession("failed");
    if (row.placement?.state === "failed") {
      row.placement.profileId = "coding";
    }

    expect(presentation(row).blocksSend).toBe(true);
  });

  it("projects local restart work ahead of the stale failed placement", () => {
    const row = placementSession("failed", "restart");
    Object.assign(row.placement!, {
      recoveryError: "Worker provider no longer recognizes the lease",
    });
    expect(presentation(row).runError?.summary).toContain("no longer recognizes the lease");
    const result = presentation(row, { restartingKey: row.key });

    expect(result.state).toEqual({ kind: "busy", message: "Restarting session…" });
    expect(result.busyMessage).toBe("Restarting session…");
    expect(result.disabledBanner).toBeUndefined();
    expect(result.runError).toBeNull();
    expect(presentation(row).runError?.summary).toContain("no longer recognizes the lease");
  });
});
