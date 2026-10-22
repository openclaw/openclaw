import { createComponent } from "solid-js";
import { vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { NewSessionPlaceControls } from "./target-controls-view.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

export const nativeRuntime = (
  id = "openclaw",
  mode: "worker-turn" | "remote-exec" = "worker-turn",
) => ({
  id,
  source: "model" as const,
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: mode,
  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
});

export const hostedRuntime = {
  id: "agentsapi",
  source: "model" as const,
  cloudPlacementSupported: false,
  workspaceEnvironment: { kind: "provider-hosted" as const, label: "OpenAI (Agents API)" },
};

export function placementControls(
  owners: Pick<NewSessionPlaceControlsOptions, "place" | "gateway" | "context">,
  data?: NewSessionPlaceControlsOptions["data"],
): NewSessionPlaceControlsOptions {
  return {
    ...owners,
    data,
    submitting: false,
    pendingPlacement: false,
    onConnectMachine: vi.fn(),
    onNavigate: vi.fn(),
    onFocusComposer: vi.fn(),
    onChange: vi.fn(),
  };
}

export function mountPlacement(...args: Parameters<typeof placementControls>) {
  const container = document.createElement("div");
  const params = placementControls(...args);
  mountSolid(() => createComponent(NewSessionPlaceControls, { params }), { container });
  return container;
}
