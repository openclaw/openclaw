/* @vitest-environment jsdom */

import { assert, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { resolvePlacementComposer } from "./chat-pane-placement.ts";

function placementSession(
  state: NonNullable<GatewaySessionRow["placement"]>["state"],
  recoveryAction?: "restart" | "stop-first",
  fields: Partial<NonNullable<GatewaySessionRow["placement"]>> = {},
): GatewaySessionRow {
  return {
    key: "agent:main:cloud",
    kind: "direct",
    updatedAt: 0,
    placement: {
      state,
      ...(recoveryAction ? { recoveryAction } : {}),
      ...fields,
    } as GatewaySessionRow["placement"],
  };
}

function presentation(
  row: GatewaySessionRow,
  overrides: Partial<Parameters<typeof resolvePlacementComposer>[0]> = {},
) {
  return resolvePlacementComposer({
    gatewaySnapshot: {
      hello: gatewayHelloForMethods(
        ["sessions.dispatch", "sessions.reclaim"],
        ["operator.read", "operator.write"],
      ),
    } as ApplicationGatewaySnapshot,
    movingKey: null,
    reclaimingKey: null,
    restartingKey: null,
    row,
    startupPending: false,
    workspaceResultReconciling: false,
    onRecover: vi.fn(),
    onReclaim: vi.fn(),
    onRetryMove: vi.fn(),
    ...overrides,
  });
}

it("projects provisioning placement into a setup composer", () => {
  expect(presentation(placementSession("provisioning"))).toMatchObject({
    state: { kind: "setup" },
    blocksSend: false,
    busyMessage: null,
  });
});

it("changes only the sync hint for current required worker inference", () => {
  const row = placementSession("active", undefined, { profileId: "coding", inference: "worker" });
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

  expect(result).toMatchObject({ blocksSend: true, busyMessage: message });
});

it.each([
  ["local", "Repository worker required", "Choose worker…"],
  ["failed", "Runner failed", "Stop cloud worker…"],
] as const)("offers the matching composer action for %s placement", (state, title, actionLabel) => {
  const onRecover = vi.fn();
  const onReclaim = vi.fn();
  const row =
    state === "failed"
      ? placementSession(state, "stop-first", { profileId: "coding" })
      : {
          ...placementSession(state),
          key: "agent:main:repository",
          repositoryWorkspaceId: "repository-workspace-1",
        };
  const result = presentation(row, { onRecover, onReclaim });
  expect(result.state).toEqual(
    state === "failed"
      ? { kind: "failed", recoveryAction: "stop-first" }
      : { kind: "dispatch-required" },
  );
  expect(result).toMatchObject({
    blocksSend: true,
    disabledBanner: { title, actionLabel },
  });
  assert(result.disabledBanner?.onAction);
  result.disabledBanner.onAction();
  expect(state === "failed" ? onReclaim : onRecover).toHaveBeenCalledOnce();
});

it("requires recovery authority even when a failed worker retains its profile", () => {
  const row = placementSession("failed", undefined, { profileId: "coding" });

  expect(presentation(row).blocksSend).toBe(true);
});

it("projects local restart work ahead of the stale failed placement", () => {
  const row = placementSession("failed", "restart", {
    recoveryError: "Worker provider no longer recognizes the lease",
  });
  expect(presentation(row).runError?.summary).toContain("no longer recognizes the lease");
  const result = presentation(row, { restartingKey: row.key });

  expect(result.state).toEqual({ kind: "busy", message: "Restarting session…" });
  expect(result).toMatchObject({
    busyMessage: "Restarting session…",
    disabledBanner: undefined,
    runError: null,
  });
  expect(presentation(row).runError?.summary).toContain("no longer recognizes the lease");
});

it.each(["retry", "missing-receipt", "reconciling", "read-only"] as const)(
  "keeps failed move admission closed with %s presentation",
  (scenario) => {
    const row = placementSession(scenario === "reconciling" ? "reconciling" : "draining");
    row.sessionId = "move-session";
    row.placementMove = {
      target: { kind: "gateway" },
      updatedAtMs: 1,
      error: "Workspace reconciliation failed.",
      ...(scenario !== "missing-receipt"
        ? {
            retry: {
              expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
              target: { kind: "gateway" as const },
            },
          }
        : {}),
    };
    const onRetryMove = vi.fn();
    const result = presentation(row, {
      onRetryMove,
      gatewaySnapshot: {
        phase: "connected",
        client: createTestGatewayClient(async () => ({})),
        hello: gatewayHelloForMethods(
          ["sessions.move"],
          [scenario === "read-only" ? "operator.read" : "operator.write"],
        ),
      } as ApplicationGatewaySnapshot,
    });
    expect(result).toMatchObject({
      state: { kind: "move-failed" },
      blocksSend: true,
      busyMessage: null,
      disabledBanner: { title: "Move failed", text: "Workspace reconciliation failed." },
    });
    if (scenario === "missing-receipt" || scenario === "reconciling") {
      expect(result.disabledBanner?.onAction).toBeUndefined();
    } else {
      expect(result.disabledBanner?.actionLabel).toBe("Retry move");
      if (scenario === "read-only") {
        expect(result.disabledBanner?.disabledReason).toBeTruthy();
      } else {
        expect(result.disabledBanner?.disabledReason).toBeUndefined();
        result.disabledBanner?.onAction?.();
        expect(onRetryMove).toHaveBeenCalledOnce();
        expect(presentation(row, { movingKey: row.key })).toMatchObject({
          state: { kind: "busy" },
          blocksSend: true,
          disabledBanner: undefined,
        });
      }
    }
  },
);
