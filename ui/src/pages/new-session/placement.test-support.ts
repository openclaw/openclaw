import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { DraftEnvironment } from "./discovery.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { NewSessionPlaceControls } from "./target-controls-view.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

export const hostedRuntime = {
  id: "agentsapi",
  source: "model" as const,
  cloudPlacementSupported: false,
  workspaceEnvironment: { kind: "provider-hosted" as const, label: "OpenAI (Agents API)" },
};

export function placementDevice(
  id: string,
  overrides: Partial<DraftEnvironment> = {},
): DraftEnvironment {
  return {
    id: `node:${id}`,
    type: "node",
    status: "available",
    sessionHost: true,
    workerSlots: { total: 1, available: 1 },
    ...overrides,
  };
}

export function placementFixture(
  model: ModelCatalogEntry,
  options: Parameters<typeof createDraftFixture>[0] = {},
) {
  return createDraftFixture({
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        model: { primary: `${model.provider}/${model.id}` },
        agentRuntime: model.agentRuntime,
      },
    ],
    modelCatalog: async () => ({ models: [model] }),
    ...options,
  });
}

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
