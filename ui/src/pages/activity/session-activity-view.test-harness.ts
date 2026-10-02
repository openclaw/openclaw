import { vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import type { renderSessionActivityView } from "./session-activity-view.ts";

export function row(
  key: string,
  owner: { id: string; label?: string },
  updatedAt: number,
  overrides: Partial<GatewaySessionRow> = {},
) {
  const actor = {
    type: "human" as const,
    ...owner,
    identity: { type: "profile" as const, id: owner.id },
  };
  return {
    key,
    kind: "direct",
    displayName: key,
    updatedAt,
    createdActor: actor,
    owner: { actor },
    ...overrides,
  } satisfies GatewaySessionRow;
}

export function props({
  rows = [],
  ...overrides
}: Partial<Parameters<typeof renderSessionActivityView>[0]> & {
  rows?: GatewaySessionRow[];
} = {}): Parameters<typeof renderSessionActivityView>[0] {
  return {
    context: {
      basePath: "",
      navigate: vi.fn(),
      gateway: {
        snapshot: { hello: null, client: null, phase: "stopped" },
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      },
      agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
      agentSelection: { state: { selectedId: "main" } },
      sessions: { state: { result: { sessions: [] } } },
    } as unknown as ApplicationContext,
    filters: { personId: null, query: "", time: "7d" as const },
    presenceViewers: [] as PresenceViewer[],
    result: {
      ts: 1,
      path: "",
      count: rows.length,
      sessions: rows,
      defaults: { model: null, modelProvider: null, contextTokens: null },
      people: [
        {
          identity: { type: "profile" as const, id: "online" },
          label: "Online person",
          sessionCount: 1,
        },
        {
          identity: { type: "profile" as const, id: "offline" },
          label: "Offline person",
          sessionCount: 1,
        },
      ],
    },
    loading: false,
    retrying: false,
    onRetry: vi.fn(),
    expandedAutomationDays: new Set<string>(),
    onAutomationDayToggle: vi.fn(),
    onFiltersChange: vi.fn(),
    ...overrides,
  };
}
