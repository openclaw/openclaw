/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatPanePlacement } from "./chat-pane-placement.tsx";

type Props = Parameters<typeof ChatPanePlacement>[0];
const timestamps = {
  generation: 2,
  createdAtMs: 100_000,
  updatedAtMs: 300_000,
  stateChangedAtMs: 300_000,
};
const activePlacement = {
  ...timestamps,
  state: "active",
  environmentId: "worker:device",
  activeOwnerEpoch: 1,
  workerBundleHash: "a".repeat(64),
  workspaceBaseManifestRef: "base-manifest",
  remoteWorkspaceDir: "/worker/repo",
} satisfies GatewaySessionRow["placement"];

function mount(session: Partial<GatewaySessionRow>, props: Omit<Props, "session"> = {}) {
  return mountSolid(() =>
    createComponent(ChatPanePlacement, {
      session: { key: "agent:main:test", kind: "direct", updatedAt: 0, ...session },
      ...props,
    }),
  ).container;
}

const part = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`.chat-pane__placement-${name}`);
const text = (container: HTMLElement, name: string) => part(container, name)?.textContent?.trim();

async function openPlacement(container: HTMLElement) {
  const panel = container.querySelector<HTMLElement>('.chat-pane__placement-menu > [role="menu"]')!;
  part(container, "chip")!.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
}

it.each(["profile", "device"] as const)(
  "presents post-turn workspace sync for %s without cloud-only wording",
  async (target) => {
    const container = mount({
      placement: {
        ...activePlacement,
        workspaceResultReconciling: true,
        inference: target === "device" ? "worker" : undefined,
        runner: target === "device" ? { kind: "device", status: "available" } : undefined,
      },
    });
    expect(text(container, "chip")).toBe("Worker · syncing files");
    await openPlacement(container);
    expect(text(container, "note")).toContain("Finalizing worker workspace");
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
  ["available", "starting", "profile", "Runs on device", "Move session…", "Stop device worker…"],
  ["offline", "failed", "profile", "Device offline", "Continue on Gateway…", "Stop device worker…"],
  [undefined, "failed", "device", "Runs on Cloud", "Move session…", "Stop cloud worker…"],
] as const)(
  "renders %s ownership ahead of %s %s startup intent",
  async (status, phase, targetKind, label, moveLabel, stopLabel) => {
    const container = mount(
      {
        placement: {
          ...activePlacement,
          runner: status ? { kind: "device", status } : undefined,
        },
      },
      {
        placementStartupStatus: { phase, targetKind },
        placementReclaimDisabledReason:
          status === "offline"
            ? "Reconnect the device to stop and sync its workspace, or Continue on Gateway."
            : undefined,
      },
    );
    expect(text(container, "chip")).toBe(label);
    await openPlacement(container);
    expect(text(container, "move")).toBe(moveLabel);
    const reclaim = part(container, "reclaim");
    expect(part(container, "move")?.hasAttribute("disabled")).toBe(false);
    expect(reclaim?.textContent?.trim()).toBe(stopLabel);
    if (status === "offline") {
      expect(text(container, "note")).toContain("Waiting for device to reconnect");
      expect(reclaim?.hasAttribute("disabled")).toBe(true);
      expect(reclaim?.title).toContain("Reconnect the device");
    } else {
      expect(part(container, "note")).toBeNull();
      expect(reclaim?.hasAttribute("disabled")).toBe(false);
    }
  },
);

it.each(["local", undefined] as const)(
  "offers worker dispatch for a repository-only session with %s placement",
  async (placementState) => {
    const onPlacementRecover = vi.fn();
    const container = mount(
      {
        repositoryWorkspaceId: "repository-workspace-1",
        placement: placementState ? { ...timestamps, state: placementState } : undefined,
      },
      { onPlacementRecover },
    );
    expect(text(container, "chip")).toBe("Worker required");
    await openPlacement(container);
    const dispatch = part(container, "recovery");
    expect(dispatch?.textContent?.trim()).toBe("Choose worker…");
    expect(part(container, "move")).toBeNull();
    dispatch?.click();
    await waitForSolid(() => expect(onPlacementRecover).toHaveBeenCalledOnce());
  },
);

it.each([
  ["restart", "recovery", "Restart session…", "reclaim"],
  ["stop-first", "reclaim", "Stop worker…", "recovery"],
] as const)(
  "offers only the %s action after worker failure",
  async (recoveryAction, action, label, absent) => {
    const container = mount({
      placement: {
        ...timestamps,
        state: "failed",
        recoveryError: "worker disappeared",
        recoveryAction,
      },
    });
    await openPlacement(container);
    expect(text(container, action)).toBe(label);
    expect(part(container, absent)).toBeNull();
  },
);
