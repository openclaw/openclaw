/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
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
    onRestart: vi.fn(),
    onReclaim: vi.fn(),
    ...overrides,
  });
}

describe("chat placement composer presentation", () => {
  it.each([
    ["active", "ready", undefined],
    ["reclaimed", "ready", undefined],
    ["provisioning", "busy", "Provisioning environment…"],
    ["syncing", "busy", "Preparing workspace…"],
    ["starting", "busy", "Starting…"],
    ["draining", "busy", "Finishing session move…"],
    ["reconciling", "busy", "Finishing session move…"],
  ] as const)("projects %s placement into a %s composer", (state, kind, busyMessage) => {
    const result = presentation(placementSession(state));

    expect(result.state.kind).toBe(kind);
    expect(result.blocksSend).toBe(state === "draining" || state === "reconciling");
    expect(result.busyMessage).toBe(busyMessage ?? null);
  });

  it.each(["active"] as const)(
    "accepts a follow-up while an %s placement reconciles a completed result",
    (state) => {
      const result = presentation(placementSession(state), { workspaceResultReconciling: true });

      expect(result.state).toEqual({
        kind: "busy",
        message: "Send now; your message starts automatically after workspace sync.",
      });
      expect(result.blocksSend).toBe(false);
      expect(result.busyMessage).toBe(
        "Send now; your message starts automatically after workspace sync.",
      );
    },
  );

  it.each([
    { state: "syncing", operation: "reclaimingKey", message: "Stopping session…" },
    { state: "syncing", operation: "restartingKey", message: "Restarting session…" },
    { state: "syncing", operation: "movingKey", message: "Finishing session move…" },
    { state: "syncing", operation: "placementMove", message: "Finishing session move…" },
    { state: "draining", message: "Finishing session move…" },
    { state: "reconciling", message: "Finishing session move…" },
    { state: "active", operation: "reclaimingKey", message: "Stopping session…" },
    { state: "active", operation: "restartingKey", message: "Restarting session…" },
    { state: "active", operation: "movingKey", message: "Finishing session move…" },
    { state: "active", operation: "placementMove", message: "Finishing session move…" },
  ] as const)("blocks sync sends during $state $operation", ({ state, message, ...scenario }) => {
    const row = placementSession(state);
    const operation = "operation" in scenario ? scenario.operation : undefined;
    if (operation === "placementMove") {
      row.placementMove = { target: { kind: "gateway" }, updatedAtMs: 1 };
    }
    const result = presentation(row, {
      workspaceResultReconciling: true,
      ...(operation && operation !== "placementMove" ? { [operation]: row.key } : {}),
    });

    expect(result.blocksSend).toBe(true);
    expect(result.busyMessage).toBe(message);
  });

  it("keeps an unfinished New Session submission blocked during setup", () => {
    expect(presentation(placementSession("syncing"), { startupPending: true }).blocksSend).toBe(
      true,
    );
  });

  it("keeps move reconciliation blocked with truthful copy", () => {
    const result = presentation(placementSession("reconciling"));

    expect(result.blocksSend).toBe(true);
    expect(result.busyMessage).toBe("Finishing session move…");
  });

  it.each(["restart", "stop-first"] as const)(
    "projects failed %s recovery into an actionable composer banner",
    (recoveryAction) => {
      const onRestart = vi.fn();
      const onReclaim = vi.fn();
      const result = presentation(placementSession("failed", recoveryAction), {
        onRestart,
        onReclaim,
      });

      expect(result.state).toEqual({ kind: "failed", recoveryAction });
      expect(result.blocksSend).toBe(true);
      expect(result.disabledBanner?.title).toBe("Runner failed");
      expect(result.disabledBanner?.actionLabel).toBe(
        recoveryAction === "restart" ? "Restart session…" : "Stop cloud worker…",
      );
      result.disabledBanner?.onAction();
      expect(recoveryAction === "restart" ? onRestart : onReclaim).toHaveBeenCalledOnce();
    },
  );

  it("projects local restart work ahead of the stale failed placement", () => {
    const row = placementSession("failed", "restart");
    const result = presentation(row, { restartingKey: row.key });

    expect(result.state).toEqual({ kind: "busy", message: "Restarting session…" });
    expect(result.busyMessage).toBe("Restarting session…");
    expect(result.disabledBanner).toBeUndefined();
  });
});
