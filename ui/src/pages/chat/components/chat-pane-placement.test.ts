/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../../app/session-placement-startup.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatPanePlacement } from "./chat-pane-placement.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function mount(
  status: "available" | "offline" | undefined,
  placementStartupStatus?: Pick<ApplicationPlacementStartupStatus, "phase" | "targetKind">,
): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const session: GatewaySessionRow = {
    key: "agent:main:device",
    kind: "direct",
    updatedAt: 0,
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: 100_000,
      updatedAtMs: 300_000,
      stateChangedAtMs: 300_000,
      environmentId: "worker:device",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
      runner: status ? { kind: "device", status } : undefined,
    },
  };
  mountSolid(
    () =>
      createComponent(ChatPanePlacement, {
        session,
        placementStartupStatus,
        placementReclaimDisabledReason:
          status === "offline"
            ? "Reconnect the device to stop and sync its workspace, or Continue on Gateway."
            : undefined,
      }),
    { container },
  );
  return container;
}

describe("chat pane device placement", () => {
  it.each(["profile", "device"] as const)(
    "presents post-turn workspace sync for %s without cloud-only wording",
    (target) => {
      const container = document.createElement("div");
      document.body.append(container);
      containers.push(container);
      const session = {
        key: "agent:main:cloud-sync",
        kind: "direct",
        updatedAt: 0,
        agentRuntime: { id: "openclaw", source: "model" as const },
        placement: {
          state: "active",
          workspaceResultReconciling: true,
          ...(target === "device"
            ? {
                providerId: "device",
                profileId: "native",
                inference: "worker" as const,
                runner: {
                  kind: "device" as const,
                  deviceId: "paired",
                  status: "available" as const,
                },
              }
            : {}),
          generation: 2,
          createdAtMs: 100_000,
          updatedAtMs: 300_000,
          stateChangedAtMs: 300_000,
          environmentId: "worker:cloud",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "base-manifest",
          remoteWorkspaceDir: "/worker/repo",
        },
      } satisfies GatewaySessionRow;

      mountSolid(() => createComponent(ChatPanePlacement, { session }), { container });

      expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
        "Worker · syncing files",
      );
      expect(container.querySelector(".chat-pane__placement-note")?.textContent).toContain(
        "Finalizing worker workspace",
      );
      expect(container.querySelector("openclaw-elapsed-time")).toBeNull();
      if (target === "device") {
        expect(container.textContent).toContain("Inference");
        expect(container.textContent).toContain("Direct from worker");
      } else {
        expect(container.textContent).not.toContain("Inference");
        expect(container.textContent).not.toContain("Through Gateway");
      }
    },
  );

  it.each([
    {
      phase: "starting" as const,
      status: "available" as const,
      targetKind: "profile" as const,
      stop: "Stop device worker…",
      label: "Runs on device",
      move: "Move session…",
      waiting: false,
    },
    {
      phase: "failed" as const,
      status: "offline" as const,
      targetKind: "profile" as const,
      stop: "Stop device worker…",
      label: "Device offline",
      move: "Continue on Gateway…",
      waiting: true,
    },
    {
      phase: "failed" as const,
      status: undefined,
      targetKind: "device" as const,
      label: "Runs on Cloud",
      move: "Move session…",
      waiting: false,
      stop: "Stop cloud worker…",
    },
  ])("renders $status active ownership ahead of $phase $targetKind startup intent", (scenario) => {
    const container = mount(scenario.status, {
      phase: scenario.phase,
      targetKind: scenario.targetKind,
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      scenario.label,
    );
    expect(container.querySelector(".chat-pane__placement-move")?.textContent?.trim()).toBe(
      scenario.move,
    );
    const note = container.querySelector(".chat-pane__placement-note");
    const move = container.querySelector<HTMLElement>(".chat-pane__placement-move");
    const reclaim = container.querySelector<HTMLElement>(".chat-pane__placement-reclaim");
    expect(move?.hasAttribute("disabled")).toBe(false);
    expect(reclaim?.textContent?.trim()).toBe(scenario.stop);
    if (scenario.waiting) {
      expect(note?.textContent).toContain("Waiting for device to reconnect");
      expect(reclaim?.hasAttribute("disabled")).toBe(true);
      expect(reclaim?.title).toContain("Reconnect the device");
    } else {
      expect(note).toBeNull();
      expect(reclaim?.hasAttribute("disabled")).toBe(false);
    }
  });

  it.each(["local", undefined] as const)(
    "offers worker dispatch for a repository-only session with %s placement",
    (placementState) => {
      const container = document.createElement("div");
      document.body.append(container);
      containers.push(container);
      const onPlacementRecover = vi.fn();
      const session: GatewaySessionRow = {
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

      mountSolid(() => createComponent(ChatPanePlacement, { session, onPlacementRecover }), {
        container,
      });

      expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
        "Worker required",
      );
      const dispatch = container.querySelector<HTMLElement>(".chat-pane__placement-recovery");
      expect(container.querySelectorAll(".chat-pane__placement-recovery")).toHaveLength(1);
      expect(dispatch?.textContent?.trim()).toBe("Choose worker…");
      expect(container.querySelector(".chat-pane__placement-move")).toBeNull();
      dispatch?.click();
      expect(onPlacementRecover).toHaveBeenCalledOnce();
    },
  );

  it("offers restart without a redundant stop action after a failed worker is gone", () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const session: GatewaySessionRow = {
      key: "agent:main:failed-worker",
      kind: "direct",
      updatedAt: 0,
      placement: {
        state: "failed",
        generation: 2,
        createdAtMs: 100_000,
        updatedAtMs: 300_000,
        stateChangedAtMs: 300_000,
        recoveryError: "worker disappeared",
        recoveryAction: "restart",
      },
    };

    mountSolid(() => createComponent(ChatPanePlacement, { session }), { container });

    expect(container.querySelector(".chat-pane__placement-recovery")?.textContent?.trim()).toBe(
      "Restart session…",
    );
    expect(container.querySelector(".chat-pane__placement-reclaim")).toBeNull();
  });

  it("requires stop before restart while the failed worker environment may remain", () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const session: GatewaySessionRow = {
      key: "agent:main:failed-worker",
      kind: "direct",
      updatedAt: 0,
      placement: {
        state: "failed",
        generation: 2,
        createdAtMs: 100_000,
        updatedAtMs: 300_000,
        stateChangedAtMs: 300_000,
        recoveryError: "worker disappeared",
        recoveryAction: "stop-first",
      },
    };

    mountSolid(() => createComponent(ChatPanePlacement, { session }), { container });

    expect(container.querySelector(".chat-pane__placement-recovery")).toBeNull();
    expect(container.querySelector(".chat-pane__placement-reclaim")?.textContent?.trim()).toBe(
      "Stop worker…",
    );
  });
});
