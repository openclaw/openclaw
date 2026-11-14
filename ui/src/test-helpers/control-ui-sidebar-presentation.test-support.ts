import type { Buffer } from "node:buffer";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  type ControlUiSessionPullRequest,
} from "../../../src/gateway/control-ui-contract.js";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";

/** Visible facts absent from the original roster-only warm-reload fixture. */
export function createTeamScaleSidebarPresentation(input: {
  agents: AgentsListResult;
  pinnedRows: GatewaySessionRow[];
  assets: Map<string, { body: string | Buffer; contentType: string }>;
  now: number;
}) {
  for (const [index, agent] of input.agents.agents.entries()) {
    const route = `/avatar/${agent.id}`;
    agent.identity = { ...agent.identity, avatarUrl: `${route}?v=${input.now}` };
    input.assets.set(route, {
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="8" fill="hsl(${index * 60} 60% 40%)"/><circle cx="20" cy="20" r="10" fill="white"/></svg>`,
    });
  }
  const requests: Record<
    string,
    { pullRequests: ControlUiSessionPullRequest[]; status: "ready"; rateLimited: false }
  > = {};
  for (const [index, row] of input.pinnedRows.slice(1, 8).entries()) {
    row.unread = true;
    row.icon = index % 2 === 0 ? "kanban" : undefined;
    row.worktree = {
      id: `sidebar-presentation-${index}`,
      branch: `fix/sidebar-${index}`,
      repoRoot: "/workspace/sidebar-fixture",
    };
    if (index % 3 === 1) {
      const agent = input.agents.agents[1]!;
      row.owner = {
        actor: { type: "agent", id: agent.id, identity: { type: "agent", id: agent.id } },
      };
    }
    requests[row.key] = {
      status: "ready",
      rateLimited: false,
      pullRequests: [
        {
          owner: "example",
          repo: "sidebar-fixture",
          number: 100 + index,
          branch: row.worktree.branch!,
          url: `https://github.com/example/sidebar-fixture/pull/${100 + index}`,
          title: `Synthetic sidebar fix ${index + 1}`,
          state: index % 3 === 0 ? "merged" : "open",
        },
      ],
    };
  }
  return {
    method: SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    event: CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
    sessions: requests,
  };
}

/** Mirrors the server subscription: independently resolved keys arrive in separate events. */
export function installTeamScaleSidebarPresentation(input: {
  method: string;
  event: string;
  sessions: Record<string, unknown>;
}) {
  const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
  gateway.setRequestHandler(
    input.method,
    ({
      params,
      respond,
    }: {
      params: { sessionKeys?: string[]; passiveSessionKeys?: string[] };
      respond: (payload: unknown) => void;
    }) => {
      respond({ subscribed: true });
      const keys = new Set([...(params.sessionKeys ?? []), ...(params.passiveSessionKeys ?? [])]);
      for (const [key, snapshot] of Object.entries(input.sessions)) {
        if (keys.has(key)) {
          gateway.emit(input.event, { sessions: { [key]: snapshot } });
        }
      }
    },
  );
}
