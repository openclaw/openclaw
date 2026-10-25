import type { GatewaySessionRow } from "../api/types.ts";

type ActivePlacement = Extract<NonNullable<GatewaySessionRow["placement"]>, { state: "active" }>;

export function createActiveSessionPlacement(
  overrides: Partial<Omit<ActivePlacement, "state">> = {},
): ActivePlacement {
  return {
    state: "active",
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    environmentId: "worker:device",
    activeOwnerEpoch: 1,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "manifest",
    remoteWorkspaceDir: "/workspace",
    ...overrides,
  };
}
