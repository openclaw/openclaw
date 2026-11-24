import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { createContext, createGateway, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  mountSolid as mountSolidRoot,
  type MountSolidOptions,
} from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { renderSessionActivityView } from "./session-activity-view.tsx";

export type SessionActivityTestProps = Parameters<typeof renderSessionActivityView>[0] & {
  context: ApplicationContext;
};

export function mountSolid<Props extends object>(
  component: (props: Props) => JSX.Element,
  wrapper?: (input: Props) => MountSolidOptions["wrapper"],
) {
  const updates = new WeakMap<HTMLElement, (props: Props) => void>();
  return (input: Props, container: HTMLElement) => {
    const update = updates.get(container);
    if (update) {
      update(input);
    } else {
      const [current, setCurrent] = createSignal<Props>(() => input, { equals: false });
      const reactiveProps = new Proxy(input, {
        get: (_target, key) => Reflect.get(current(), key),
      });
      mountSolidRoot(() => component(reactiveProps), { container, wrapper: wrapper?.(input) });
      updates.set(container, (next) => setCurrent(() => next));
    }
    flush();
  };
}

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
}: Partial<SessionActivityTestProps> & {
  rows?: GatewaySessionRow[];
} = {}): SessionActivityTestProps {
  return {
    context: {
      ...createContext(
        createGateway(createTestGatewayClient(vi.fn(async () => ({})))),
        createSessions("main", []),
        { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [] },
      ),
      basePath: "",
      navigate: vi.fn(),
    },
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
