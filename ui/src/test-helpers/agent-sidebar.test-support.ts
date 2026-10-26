import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
  TWO_AGENTS,
} from "./app-sidebar.ts";
import { createApplicationContextProvider } from "./application-context.ts";
import { createTestGatewayClient } from "./gateway-client.ts";
import { settleLitElement } from "./lit-settle.ts";

export const viewer = { type: "human" as const, id: "viewer", label: "Viewer" };
export const other = { type: "human" as const, id: "other", label: "Other" };
export function ownedSession(
  key: string,
  ownerId = viewer.id,
  extra: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key,
    agentId: key.split(":")[1],
    kind: "direct",
    owner: { actor: { type: "human", id: ownerId } },
    ...extra,
  };
}

export async function withOwnerSidebar(
  rows: GatewaySessionRow[],
  owners: NonNullable<SessionsListResult["owners"]>,
  mode: "query" | "personal",
  check: (fixture: {
    sidebar: Awaited<ReturnType<typeof createSidebarElement>>;
    context: ReturnType<typeof createContext>;
    requests: Record<string, unknown>[];
    settle: () => Promise<void>;
  }) => Promise<void>,
) {
  const requests: Record<string, unknown>[] = [];
  const overflow = createDeferred<SessionsListResult>();
  const gateway = createGatewayHarness(
    createTestGatewayClient(async (method, raw) => {
      const params = asOptionalRecord(raw);
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.describe") {
        return { session: rows.find((row) => row.key === params?.key) ?? null };
      }
      if (method === "sessions.groups.list") {
        return { names: [], groups: [], sectionOrder: [] };
      }
      if (method !== "sessions.list") {
        return {};
      }
      if (mode === "query" && params?.source === "sidebar") {
        requests.push(params);
        // Bound the regression's render loop without changing personal-scope transport.
        if (requests.length > 8) {
          queueMicrotask(() => stop());
          return overflow.promise;
        }
      }
      const selected = rows.filter(
        (row) =>
          (!params?.agentId || row.agentId === params.agentId) &&
          (!params?.ownerId || row.owner?.actor.id === params.ownerId),
      );
      return { ...sessionsResult(selected, 1), owners };
    }),
  );
  gateway.publish({ selfUser: { id: viewer.id, name: viewer.label } });
  if (mode === "query") {
    const hello = gateway.gateway.snapshot.hello!;
    gateway.publish({
      hello: { ...hello, policy: { ...hello.policy, hasMultipleSessionSharingIdentities: false } },
    });
  }
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const context = createContext(gateway.gateway, sessions, mode === "personal" ? TWO_AGENTS : null);
  const provider = createApplicationContextProvider(context);
  const sidebar = await createSidebarElement();
  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    provider.remove();
    context.connectionBootstrap.reset();
    sessions.dispose();
  };
  sidebar.activeRouteId = "chat";
  sidebar.sidebarAgentsMode = "chip";
  provider.append(sidebar.hostElement);
  document.body.append(provider);
  const settle = async () => {
    await settleLitElement(sidebar);
    await nextTurn();
    await settleLitElement(sidebar);
  };
  try {
    sidebar.connected = true;
    await check({ sidebar, context, requests, settle });
  } finally {
    stop();
    if (mode === "query") {
      overflow.resolve(sessionsResult([], 1));
      await settle();
    }
  }
}
