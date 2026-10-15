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
  it.each([["provisioning", "setup", undefined]] as const)(
    "projects %s placement into a %s composer",
    (state, kind, busyMessage) => {
      const result = presentation(placementSession(state));

      expect(result.state.kind).toBe(kind);
      expect(result.blocksSend).toBe(false);
      expect(result.busyMessage).toBe(busyMessage ?? null);
    },
  );

  it.each([
    {
      name: "current required worker inference",
      required: "coding",
      profile: "coding",
      inference: "worker",
      hidden: true,
    },
  ] as const)(
    "changes only the sync hint for $name",
    ({ required, profile, inference, hidden }) => {
      const row = placementSession("active");
      Object.assign(row.placement!, { profileId: profile, inference });
      const original = presentation(row, { workspaceResultReconciling: true });
      const result = presentation(row, {
        workspaceResultReconciling: true,
        requiredWorkerInferenceProfileId: required,
      });
      expect(result).toEqual({ ...original, busyMessage: hidden ? null : original.busyMessage });
      expect(result.blocksSend).toBe(false);
      expect(result.state.kind).toBe("busy");
    },
  );

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

  it.each(["local"] as const)(
    "blocks a repository-only session with %s placement and offers worker dispatch",
    (placementState) => {
      const onRecover = vi.fn();
      const row: GatewaySessionRow = {
        key: "agent:main:repository",
        kind: "direct",
        updatedAt: 0,
        repositoryWorkspaceId: "repository-workspace-1",
        ...(placementState
          ? {
              placement: {
                state: placementState,
                generation: 1,
                createdAtMs: 1,
                updatedAtMs: 1,
                stateChangedAtMs: 1,
              },
            }
          : {}),
      };

      const result = presentation(row, { onRecover });

      expect(result.state).toEqual({ kind: "dispatch-required" });
      expect(result.blocksSend).toBe(true);
      expect(result.disabledBanner).toMatchObject({
        title: "Repository worker required",
        actionLabel: "Choose worker…",
      });
      assert(result.disabledBanner?.onAction);
      result.disabledBanner.onAction();
      expect(onRecover).toHaveBeenCalledOnce();
    },
  );

  it.each(["stop-first"] as const)(
    "projects failed %s recovery into an actionable composer banner",
    (recoveryAction) => {
      const onRecover = vi.fn();
      const onReclaim = vi.fn();
      const row = placementSession("failed", recoveryAction);
      if (row.placement?.state === "failed" && recoveryAction === "stop-first") {
        row.placement.profileId = "coding";
      }
      const result = presentation(row, {
        onRecover,
        onReclaim,
      });

      expect(result.state).toEqual({ kind: "failed", recoveryAction });
      expect(result.blocksSend).toBe(true);
      expect(result.disabledBanner?.title).toBe("Runner failed");
      expect(result.disabledBanner?.actionLabel).toBe("Stop cloud worker…");
      assert(result.disabledBanner?.onAction);
      result.disabledBanner.onAction();
      expect(onReclaim).toHaveBeenCalledOnce();
    },
  );

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
