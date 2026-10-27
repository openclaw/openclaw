import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";

type Placement = NonNullable<GatewaySessionRow["placement"]>;

export function cloudSession(key: string, label: string, now: number, placement: Placement) {
  return { key, kind: "direct", label, updatedAt: now, placement } satisfies GatewaySessionRow;
}

export function activePlacement(
  now: number,
  overrides: Partial<Extract<Placement, { state: "active" }>> = {},
): Placement {
  return {
    state: "active",
    generation: 1,
    createdAtMs: now - 60_000,
    updatedAtMs: now,
    stateChangedAtMs: now - 30_000,
    environmentId: "worker:cloud-session",
    activeOwnerEpoch: 1,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "sha256:cloud-session-base",
    remoteWorkspaceDir: "/workspace/cloud-session",
    ...overrides,
  };
}

export function cloudSessionList(session: GatewaySessionRow): SessionsListResult {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
    path: "",
    sessions: [session],
    ts: session.updatedAt ?? 0,
  };
}
