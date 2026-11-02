/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { createPlacementPane, type AsyncRequest } from "./chat-pane-placement.test-support.ts";
import {
  resolveChatPanePlacement,
  resolveChatPaneWorkerPresentation,
} from "./chat-pane-placement.ts";
import {
  createRenderTestChatPane,
  activePlacementSession,
  offlineDeviceSession,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { ChatMachine } from "./components/chat-machine.tsx";
import { ChatPanePlacement } from "./components/chat-pane-placement.tsx";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});
afterEach(async () => {
  try {
    await dialogs.cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});

const placementTiming = { generation: 1, createdAtMs: 1, updatedAtMs: 1, stateChangedAtMs: 1 };
const workerPlacement = {
  ...placementTiming,
  providerId: "device-service",
  profileId: "device-profile",
  environmentId: "node:device-looking-id",
};

const startupPlacements = [
  { state: "requested", ...placementTiming },
  { state: "provisioning", ...workerPlacement },
  { state: "syncing", ...workerPlacement, workerBundleHash: "a".repeat(64) },
  {
    state: "starting",
    ...workerPlacement,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "base",
    remoteWorkspaceDir: "/workspace",
  },
] as const satisfies readonly NonNullable<GatewaySessionRow["placement"]>[];

function startupSession(placement: GatewaySessionRow["placement"]): GatewaySessionRow {
  return {
    key: "agent:main:startup",
    label: "Startup session",
    kind: "direct",
    updatedAt: 1,
    placement,
  };
}

function startReclaim(pane: ReturnType<typeof createTestChatPane>["pane"], row: GatewaySessionRow) {
  const state = pane.state!;
  state.sessionKey = row.key;
  state.currentSessionId = row.sessionId ?? null;
  state.sessionsResult = { ...createSessionsListResult(), sessions: [row] };
  return pane.changeHeaderPlacement(row, "reclaim");
}

function reclaimFixture(handler?: AsyncRequest, scopes = ["operator.admin"]) {
  return createPlacementPane(dialogs, handler, scopes, ["sessions.reclaim"]);
}

function requestedSession(pane: ReturnType<typeof createTestChatPane>["pane"]) {
  const session = { ...activePlacementSession(), placement: startupPlacements[0] };
  vi.mocked(pane.context.placementStartup.get).mockReturnValue({
    sessionKey: session.key,
    phase: "requested",
    startedAt: 1,
    targetKind: "device",
  });
  return session;
}

describe("chat pane startup worker copy", () => {
  it("retains the startup retry callback across renders and resolves the current pane session", () => {
    const context = createInitializationContext();
    const pane = createRenderTestChatPane();
    const state = pane.initialize(context);
    state.sessionKey = "agent:main:startup";
    const startup = {
      sessionKey: state.sessionKey,
      phase: "failed" as const,
      startedAt: 1,
      retryable: true,
      initialTurn: {
        id: "initial",
        text: "Retained prompt",
        createdAt: 1,
        sendState: "failed" as const,
      },
    };
    const get = vi.spyOn(context.placementStartup, "get").mockImplementation((sessionKey) => ({
      ...startup,
      sessionKey,
    }));
    const retry = vi.spyOn(context.placementStartup, "retry");
    pane.render();
    const action = expectDefined(pane.chatProps?.onRetrySessionPlacementStartup, "startup retry");
    pane.render();
    expect(pane.chatProps?.onRetrySessionPlacementStartup).toBe(action);
    action();
    expect(retry).toHaveBeenLastCalledWith(state.sessionKey);

    const nextState = pane.initialize(context);
    nextState.sessionKey = "agent:main:next-startup";
    action();
    expect(retry).toHaveBeenLastCalledWith(nextState.sessionKey);
    expect(retry).toHaveBeenCalledTimes(2);
    pane.render();
    expect(pane.chatProps?.onRetrySessionPlacementStartup).toBe(action);

    get.mockReturnValue({ ...startup, retryable: false });
    pane.render();
    expect(pane.chatProps?.onRetrySessionPlacementStartup).toBeUndefined();
  });
});

describe("chat pane worker stop", () => {
  it.each([
    [0, "device", "Runs on device", "Stop device worker…"],
    [0, "profile", "Runs on Cloud", "Stop cloud worker…"],
    [2, "profile", "device-service · device-profile", "Stop cloud worker…"],
    [3, undefined, "Runs on worker", "Stop worker…"],
  ] as const)("presents startup worker %s/%s", (index, targetKind, label, stopLabel) => {
    const placement = startupPlacements[index];
    expect(
      resolveChatPaneWorkerPresentation(startupSession(placement), {
        phase: placement.state,
        targetKind,
      }),
    ).toMatchObject({ label, stopLabel });
  });

  it("stops a requested worker through its native menu", async () => {
    const { pane, request } = reclaimFixture();
    const session = startupSession(startupPlacements[0]);
    const startup = {
      sessionKey: session.key,
      phase: "requested" as const,
      startedAt: 1,
      targetKind: "device" as const,
    };
    vi.mocked(pane.context.placementStartup.get).mockReturnValue(startup);
    const container = document.createElement("div");
    document.body.append(container);
    let reclaim: Promise<void> | undefined;
    mountSolid(
      () =>
        createComponent(ChatPanePlacement, {
          session,
          placementStartupStatus: startup,
          onPlacementReclaim: () => {
            reclaim = dialogs.track(startReclaim(pane, session));
          },
        }),
      { container },
    );
    flush();
    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Runs on device",
    );
    container.querySelector<HTMLButtonElement>(".chat-pane__placement-chip")!.click();
    await waitForSolid(() =>
      expect(
        container
          .querySelector('.chat-pane__placement-menu > [role="menu"]')
          ?.matches(":popover-open"),
      ).toBe(true),
    );
    const stop = container.querySelector<HTMLButtonElement>(".chat-pane__placement-reclaim");
    expect(stop?.textContent?.trim()).toBe("Stop device worker…");
    stop?.click();
    const actions = await waitForConfirmDialogActions();
    expect(document.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "This will save workspace changes and stop this session’s worker",
    );
    expect(actions.querySelector(".btn.danger [aria-hidden=false]")?.textContent?.trim()).toBe(
      "Stop worker",
    );
    answerConfirmDialog(actions, "confirm");
    await reclaim;
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.reclaim",
      { key: session.key, agentId: "main" },
      { timeoutMs: null },
    );
    expect(pane.context.placementStartup.pause).toHaveBeenCalledBefore(request);
  });

  it("does not issue reclaim for an offline device placement", async () => {
    const { pane, request } = reclaimFixture(undefined, ["operator.read", "operator.write"]);

    await startReclaim(pane, { ...offlineDeviceSession(), hasActiveRun: false });

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("dialog[open]")).toBeNull();
  });

  it.each([false, true])(
    "reclaims an active device despite failed startup intent (refresh throws=%s)",
    async (refreshThrows) => {
      vi.stubGlobal(
        "confirm",
        vi.fn(() => {
          throw new Error("native confirm must not be used");
        }),
      );
      const { pane, request, reconcileMutation } = reclaimFixture(undefined, [
        "operator.read",
        "operator.write",
      ]);
      if (refreshThrows) {
        reconcileMutation.mockRejectedValueOnce(new Error("refresh failed after stop"));
      }
      const session = activePlacementSession();
      session.placement.runner = { kind: "device", status: "available" };
      vi.mocked(pane.context.placementStartup.get).mockReturnValue({
        sessionKey: session.key,
        phase: "failed",
        startedAt: 1,
        targetKind: "profile",
      });

      const reclaim = dialogs.track(startReclaim(pane, session));
      const actions = await waitForConfirmDialogActions();
      const actionText = actions.textContent;
      const confirmation = document.body.querySelector("openclaw-modal-dialog")?.textContent;
      const pausesBeforeConfirmation = vi.mocked(pane.context.placementStartup.pause).mock.calls
        .length;
      answerConfirmDialog(actions, "confirm");
      await reclaim;

      expect(actionText).toContain("Stop worker");
      expect(confirmation).toContain("Stop worker?");
      expect(confirmation).toContain("Send a new message to continue.");
      expect(pausesBeforeConfirmation).toBe(0);
      expect(request).toHaveBeenCalledWith(
        "sessions.reclaim",
        { key: session.key, agentId: "main" },
        { timeoutMs: null },
      );
      expect(pane.context.placementStartup.pause).toHaveBeenCalledExactlyOnceWith(
        session.key,
        "Worker stop requested. Review the initial message before retrying.",
        expect.objectContaining({
          readSessionPlacementRecovery: expect.any(Function),
          pauseSessionPlacementRecovery: expect.any(Function),
        }),
      );
      expect(pane.context.placementStartup.pause).toHaveBeenCalledBefore(request);
      expect(reconcileMutation).toHaveBeenCalledWith("main");
      expect(request).toHaveBeenCalledOnce();
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it("does not reclaim when the operator cancels", async () => {
    const { pane, request } = reclaimFixture();
    const session = requestedSession(pane);

    const reclaim = dialogs.track(startReclaim(pane, session));
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "cancel");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
  });

  it("does not reclaim after the connection changes while confirmation is open", async () => {
    const { pane, state, request } = reclaimFixture();
    const session = requestedSession(pane);

    const reclaim = dialogs.track(startReclaim(pane, session));
    const actions = await waitForConfirmDialogActions();
    pane.connectionGeneration += 1;
    answerConfirmDialog(actions, "confirm");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("retries a failed reclaim from the same dialog", async () => {
    let calls = 0;
    const { pane, state, request } = reclaimFixture(async () => {
      if (calls++ === 0) {
        throw new Error("reclaim failed");
      }
      return { ok: true };
    });
    const session = activePlacementSession();

    const reclaim = dialogs.track(startReclaim(pane, session));
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "confirm");
    await vi.waitFor(() => expect(state.lastError).toBe("reclaim failed"));
    expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(actions.querySelector<HTMLButtonElement>(".btn.danger")?.disabled).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(state.lastError).toBe("reclaim failed");
    expect(state.chatError).toBe(state.lastError);
    answerConfirmDialog(actions, "confirm");
    await reclaim;
    expect(request).toHaveBeenCalledTimes(2);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("does not publish a reclaim failure after leaving and returning", async () => {
    const response = createDeferred<{ ok: true }>();
    const { pane, state, request } = reclaimFixture(() => response.promise);
    const session = activePlacementSession();

    try {
      const reclaim = dialogs.track(startReclaim(pane, session));
      const actions = await waitForConfirmDialogActions();
      answerConfirmDialog(actions, "confirm");
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      pane.presented = false;
      pane.presented = true;
      response.reject(new Error("stale reclaim failed"));
      await reclaim;

      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    } finally {
      response.resolve({ ok: true });
    }
  });

  it("keeps reclaim progress with its session when the pane switches rows", async () => {
    const response = createDeferred<{ ok: true }>();
    const { pane, state, request } = reclaimFixture(() => response.promise);
    const sessionA = activePlacementSession("agent:main:cloud-a");
    const sessionB = {
      ...sessionA,
      key: "agent:main:cloud-b",
      placement: {
        ...sessionA.placement,
        environmentId: "worker:two",
        remoteWorkspaceDir: "/worker/repo-b",
      },
    } satisfies GatewaySessionRow;

    try {
      const pendingReclaim = dialogs.track(startReclaim(pane, sessionA));
      const actions = await waitForConfirmDialogActions();
      answerConfirmDialog(actions, "confirm");
      await vi.waitFor(() =>
        expect(pane.headerPresentation.placementReclaimingKey).toBe(sessionA.key),
      );

      const modal = document.querySelector("openclaw-modal-dialog")!;
      const pendingCancel = new CustomEvent("modal-cancel", { cancelable: true });
      modal.dispatchEvent(pendingCancel);
      expect(pendingCancel.defaultPrevented).toBe(true);
      expect(actions.querySelector<HTMLButtonElement>(".btn[autofocus]")?.disabled).toBe(true);
      expect(actions.querySelector<HTMLButtonElement>(".btn.danger")?.disabled).toBe(true);
      expect(
        document.querySelector<HTMLButtonElement>(".session-worker-stop__close")?.disabled,
      ).toBe(true);
      answerConfirmDialog(actions, "confirm");
      await pane.changeHeaderPlacement(sessionA, "reclaim");
      expect(request).toHaveBeenCalledTimes(1);
      expect(document.querySelector("openclaw-modal-dialog")).toBe(modal);

      state.sessionKey = sessionB.key;
      const placementA = resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: pane.headerPresentation.placementReclaimingKey,
        row: sessionA,
      });
      const placementB = resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: pane.headerPresentation.placementReclaimingKey,
        row: sessionB,
      });
      expect(placementA.reclaimDisabledReason).toBe(t("common.loading"));
      expect(placementB.reclaimDisabledReason).toBeUndefined();

      response.resolve({ ok: true });
      await pendingReclaim;

      expect(pane.headerPresentation.placementReclaimingKey).toBeNull();
    } finally {
      response.resolve({ ok: true });
    }
  });
});

describe("Machine and Stop owner contracts", () => {
  it.each([false, true])(
    "projects available machine facts and native actions with offline=%s",
    (offline) => {
      const session = offline ? offlineDeviceSession() : activePlacementSession();
      const onMove = vi.fn();
      const view = mountSolid(() =>
        createComponent(ChatMachine, {
          session,
          machineName: "Build device",
          onPlacementMove: onMove,
          onPlacementReclaim: vi.fn(),
        }),
      );
      flush();
      const body = view.container;
      expect(body.querySelector(".chat-machine__identity strong")?.textContent).toBe(
        "Build device",
      );
      const recovery = body.querySelector(".chat-machine__recovery");
      expect(Boolean(recovery)).toBe(offline);
      if (recovery) {
        expect(
          recovery.compareDocumentPosition(body.querySelector("dl")!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        recovery.querySelector<HTMLButtonElement>("button")!.click();
      } else {
        body.querySelector<HTMLButtonElement>(".chat-machine__action")!.click();
      }
      expect(onMove).toHaveBeenCalledOnce();
    },
  );
});
