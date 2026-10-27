/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMoveTarget } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  sessionPlacementAction,
  sessionPlacementActionReason,
} from "../../components/session-placement-action.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { activePlacementSession, createTestChatPane } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});
afterEach(() => dialogs.cleanup());

function fixture(target: SessionMoveTarget = { kind: "gateway" }, abandonSource?: true) {
  const request = dialogs.mockRequest(async () => ({ ok: true }));
  const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture({ reconcileMutation }),
  });
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["sessions.move"],
    ["operator.admin", "operator.write"],
  );
  const original = activePlacementSession();
  const session: GatewaySessionRow = {
    ...original,
    sessionId: "retry-session",
    label: "Retry release review",
    placement: { ...original.placement, state: "draining", generation: 2 },
    placementMove: {
      target,
      updatedAtMs: 2,
      error: "Workspace reconciliation failed.",
      retry: {
        expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
        target,
        ...(abandonSource ? { abandonSource } : {}),
      },
    },
  };
  state.sessionKey = session.key;
  state.currentSessionId = session.sessionId;
  state.sessionsResult = { ...createSessionsListResult(), sessions: [session] };
  const run = () =>
    dialogs.track(pane.handleHeaderSessionAction({ kind: "move-session" }, session));
  return { pane, state, session, request, reconcileMutation, run };
}

describe("durable placement move retry", () => {
  it.each([
    { kind: "gateway" },
    { kind: "device", deviceId: "build-device" },
    { kind: "profile", profileId: "cloud", os: "windows/wsl2", machineClass: "fast" },
  ] satisfies SessionMoveTarget[])(
    "retries the exact $kind intent without a destination picker",
    async (target) => {
      const { session, request, reconcileMutation, run } = fixture(target);
      expect(sessionPlacementAction(session)).toBe("retry");
      await run();
      expect(request).toHaveBeenCalledExactlyOnceWith("sessions.move", {
        key: session.key,
        agentId: "main",
        expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
        target,
      });
      expect(reconcileMutation).toHaveBeenCalledWith("main");
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it.each([
    "missing-receipt",
    "missing-receipt-active",
    "pending",
    "reconciling",
    "active",
    "archived",
    "profile-without-admin",
    "required-profile",
  ] as const)("refuses %s instead of changing the destination", async (scenario) => {
    const { pane, session, request, run } = fixture({ kind: "profile", profileId: "cloud" });
    if (scenario === "missing-receipt" || scenario === "missing-receipt-active") {
      session.placementMove!.retry = undefined;
      if (scenario === "missing-receipt-active" && session.placement?.state === "draining") {
        session.placement = { ...session.placement, state: "active" };
      }
    }
    if (scenario === "pending") {
      session.placementMove!.error = undefined;
    }
    if (scenario === "reconciling" && session.placement?.state === "draining") {
      session.placement = { ...session.placement, state: "reconciling" };
    }
    if (scenario === "active" && session.placement?.state === "draining") {
      session.placement = { ...session.placement, state: "active" };
    }
    if (scenario === "archived") {
      session.archived = true;
    }
    if (scenario === "profile-without-admin") {
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.move"],
        ["operator.write"],
      );
    }
    if (scenario === "required-profile") {
      pane.context.agents.state.agentsList = {
        ...pane.context.agents.state.agentsList!,
        sessionPlacement: { requiredProfile: { id: "required", providerId: "device" } },
      };
    }
    await run();
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("requires explicit destructive confirmation again when retrying abandonment", async () => {
    const { session, request, run } = fixture({ kind: "gateway" }, true);
    const cancelled = run();
    answerConfirmDialog(await waitForConfirmDialogActions(), "cancel");
    await cancelled;
    expect(request).not.toHaveBeenCalled();
    const retried = run();
    const confirmation = await waitForConfirmDialogActions();
    expect(document.body.textContent).toContain(
      "Unsynced device files and in-flight work may be lost",
    );
    answerConfirmDialog(confirmation, "confirm");
    await retried;
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.move", {
      key: session.key,
      agentId: "main",
      ...session.placementMove!.retry,
    });
  });

  it.each(["source", "target", "disposition"] as const)(
    "rejects a changed durable %s after confirmation",
    async (field) => {
      const { session, request, run } = fixture({ kind: "gateway" }, true);
      const retried = run();
      const confirmation = await waitForConfirmDialogActions();
      const receipt = session.placementMove!.retry!;
      if (field === "source") {
        receipt.expected.generation = 8;
      }
      if (field === "target") {
        session.placementMove = {
          ...session.placementMove!,
          target: { kind: "device", deviceId: "other" },
          retry: { expected: receipt.expected, target: { kind: "device", deviceId: "other" } },
        };
      }
      if (field === "disposition") {
        receipt.abandonSource = undefined;
      }
      answerConfirmDialog(confirmation, "confirm");
      await retried;
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("preserves a failed retry visibly and permits a required-profile retry only to that profile", async () => {
    const { pane, state, session, request, run } = fixture({
      kind: "profile",
      profileId: "required",
    });
    pane.context.agents.state.agentsList = {
      ...pane.context.agents.state.agentsList!,
      sessionPlacement: { requiredProfile: { id: "required", providerId: "device" } },
    };
    expect(
      sessionPlacementActionReason(pane.context.gateway.snapshot, session, "required"),
    ).toBeUndefined();
    request.mockRejectedValueOnce(new Error("Workspace still cannot be reconciled."));
    await run();
    expect(state.lastError).toContain("Workspace still cannot be reconciled");
    expect(session.placementMove!.retry!.expected.generation).toBe(1);
    expect(sessionPlacementAction(session)).toBe("retry");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["failed", "local"] as const)(
    "does not select an alternate destination through %s recovery while a Move is outstanding",
    async (placementState) => {
      const { pane, session, request } = fixture();
      session.placement =
        placementState === "failed"
          ? {
              state: "failed",
              generation: 3,
              createdAtMs: 1,
              updatedAtMs: 3,
              stateChangedAtMs: 3,
              recoveryError: "Worker failed",
              recoveryAction: "restart",
            }
          : { state: "local", generation: 3, createdAtMs: 1, updatedAtMs: 3, stateChangedAtMs: 3 };
      session.repositoryWorkspaceId = "repository-workspace";
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.move", "sessions.dispatch", "sessions.reclaim"],
        ["operator.admin", "operator.write"],
      );
      await pane.changeHeaderPlacement(session, "recover");
      expect(request).not.toHaveBeenCalled();
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );
});
