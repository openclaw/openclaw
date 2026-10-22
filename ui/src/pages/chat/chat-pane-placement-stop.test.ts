/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  resolveChatPanePlacement,
  resolveChatPaneWorkerPresentation,
} from "./chat-pane-placement.ts";
import {
  createInitializationContext,
  createRenderTestChatPane,
  activePlacementSession,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
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

const deviceCopy = {
  label: "Runs on device",
  stopLabel: "Stop device worker…",
  confirmMessage: 'Stop the device worker for "Startup session"?',
  confirmLabel: "Stop device worker",
};
const cloudCopy = {
  label: "Runs on Cloud",
  stopLabel: "Stop cloud worker…",
  confirmMessage: 'Stop the cloud worker for "Startup session"?',
  confirmLabel: "Stop worker",
};
const unknownCopy = {
  label: "Runs on worker",
  stopLabel: "Stop worker…",
  confirmMessage: 'Stop the worker for "Startup session"?',
  confirmLabel: "Stop worker",
};

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

  it("uses generic cloud copy before a requested profile has worker metadata", () => {
    expect(
      resolveChatPaneWorkerPresentation(startupSession(startupPlacements[0]), {
        phase: "requested",
        targetKind: "profile",
      }),
    ).toEqual(cloudCopy);
  });
});

describe("chat pane worker stop", () => {
  it.each([
    { placement: startupPlacements[0], targetKind: "device", copy: deviceCopy },
    {
      placement: startupPlacements[2],
      targetKind: "profile",
      copy: { ...cloudCopy, label: "device-service · device-profile" },
    },
    { placement: startupPlacements[3], targetKind: undefined, copy: unknownCopy },
  ] as const)(
    "stops $placement.state $targetKind startup from the placement menu",
    async ({ placement, targetKind, copy }) => {
      const request = dialogs.mockRequest(async () => ({ ok: true }));
      const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture({ reconcileMutation }),
      });
      const session = startupSession(placement);
      const startup = targetKind
        ? { sessionKey: session.key, phase: placement.state, startedAt: 1, targetKind }
        : null;
      vi.mocked(pane.context.placementStartup.get).mockReturnValue(startup);
      const container = document.createElement("div");
      document.body.append(container);
      let reclaim: Promise<void> | undefined;
      const view = mountSolid(
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
      onTestFinished(view.unmount);
      flush();
      expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
        copy.label,
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
      expect(stop?.textContent?.trim()).toBe(copy.stopLabel);
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
    },
  );

  it("disables offline Stop while keeping Continue enabled, then restores ordinary actions", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move", "sessions.reclaim"],
      ["operator.read", "operator.write"],
    );
    const offline = {
      ...offlineDeviceSession(),
      sessionId: "offline-device-session",
      hasActiveRun: false,
    };
    const available = {
      ...offline,
      placement: {
        ...offline.placement,
        runner: { kind: "device" as const, status: "available" as const },
      },
    };

    expect(
      resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: null,
        row: offline,
      }),
    ).toEqual({
      moving: false,
      restarting: false,
      moveDisabledReason: undefined,
      reclaimDisabledReason:
        "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
      recoveryDisabledReason: "This Gateway does not support this session action.",
    });
    expect(
      resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: null,
        row: available,
      }),
    ).toEqual({
      moving: false,
      restarting: false,
      moveDisabledReason: undefined,
      reclaimDisabledReason: undefined,
      recoveryDisabledReason: "This Gateway does not support this session action.",
    });
  });

  it("requires restoring an archived repository session before worker dispatch", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.dispatch"],
      ["operator.read", "operator.write"],
    );

    expect(
      resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: null,
        row: {
          key: "agent:main:archived-repository",
          kind: "direct",
          updatedAt: 0,
          archived: true,
          repositoryWorkspaceId: "repository-workspace-1",
          placement: {
            state: "local",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            stateChangedAtMs: 1,
          },
        },
      }).recoveryDisabledReason,
    ).toBe("This session is archived. Unarchive it to continue the conversation.");
  });

  it("does not issue reclaim for an offline device placement", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.read", "operator.write"],
    );

    await startReclaim(pane, { ...offlineDeviceSession(), hasActiveRun: false });

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("dialog[open]")).toBeNull();
  });

  it.each([
    { runner: "device", startupPhase: "failed", refreshThrows: false },
    { runner: "device", startupPhase: "failed", refreshThrows: true },
  ] as const)(
    "reclaims an active $runner placement with conflicting $startupPhase intent after confirmation (refresh throws=$refreshThrows)",
    async ({ runner, startupPhase, refreshThrows }) => {
      vi.stubGlobal(
        "confirm",
        vi.fn(() => {
          throw new Error("native confirm must not be used");
        }),
      );
      const request = dialogs.mockRequest(async () => ({ ok: true }));
      const reconcileMutation = vi.fn(async () => {
        if (refreshThrows) {
          throw new Error("refresh failed after stop");
        }
        return { status: "refreshed" as const };
      });
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture({ reconcileMutation }),
      });
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.reclaim"],
        ["operator.read", "operator.write"],
      );
      const session = activePlacementSession();
      if (runner === "device") {
        session.placement.runner = { kind: "device", status: "available" };
      }
      vi.mocked(pane.context.placementStartup.get).mockReturnValue({
        sessionKey: session.key,
        phase: startupPhase,
        startedAt: 1,
        targetKind: runner === "device" ? "profile" : "device",
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
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
    const session = {
      ...activePlacementSession(),
      placement: {
        state: "requested",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      },
    } satisfies GatewaySessionRow;
    vi.mocked(pane.context.placementStartup.get).mockReturnValue({
      sessionKey: session.key,
      phase: "requested",
      startedAt: 1,
      targetKind: "device",
    });

    const reclaim = dialogs.track(startReclaim(pane, session));
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "cancel");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
  });

  it("does not reclaim after the connection changes while confirmation is open", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
    const session = {
      ...activePlacementSession(),
      placement: {
        state: "requested",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      },
    } satisfies GatewaySessionRow;
    vi.mocked(pane.context.placementStartup.get).mockReturnValue({
      sessionKey: session.key,
      phase: "requested",
      startedAt: 1,
      targetKind: "device",
    });

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
    const request = dialogs.mockRequest(async () => {
      if (calls++ === 0) {
        throw new Error("reclaim failed");
      }
      return { ok: true };
    });
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
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
    const request = dialogs.mockRequest(() => response.promise);
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
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
    const request = dialogs.mockRequest(() => response.promise);
    const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({ reconcileMutation }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
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
      onTestFinished(view.unmount);
      flush();
      const body = view.container;
      expect(body.querySelector(".chat-machine__identity strong")?.textContent).toBe(
        "Build device",
      );
      const labels = [...body.querySelectorAll("dt")].map((node) => node.textContent);
      expect(labels[0]).toBe("ID");
      expect(labels).not.toContain("Machine");
      expect(labels).not.toContain("Profile");
      expect(body.textContent).not.toContain("undefined");
      expect(body.querySelectorAll("dl")).toHaveLength(offline ? 2 : 1);
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
