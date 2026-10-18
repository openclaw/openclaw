/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";

const viewer = { type: "human" as const, id: "viewer", label: "Viewer" };

async function mountOwnerQuery(
  rows: GatewaySessionRow[],
  owners: NonNullable<SessionsListResult["owners"]>,
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
      if (params?.source === "sidebar") {
        requests.push(params);
        // Stop a broken response/render cycle at the test's transport boundary,
        // so the request-count assertion can report it without starving the runner.
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
  const hello = gateway.gateway.snapshot.hello!;
  gateway.publish({
    selfUser: { id: viewer.id, name: viewer.label },
    hello: { ...hello, policy: { ...hello.policy, hasMultipleSessionSharingIdentities: false } },
  });
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const context = createContext(gateway.gateway, sessions);
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
  sidebar.connected = true;

  const settle = async () => {
    await settleLitElement(sidebar);
    // Drain completed transport promises through the real render lifecycle.
    // The response budget above bounds the defective microtask feedback loop.
    await nextTurn();
    await settleLitElement(sidebar);
  };
  return {
    sidebar,
    requests,
    settle,
    async dispose() {
      stop();
      overflow.resolve(sessionsResult([], 1));
      await settle();
    },
  };
}

function ownSession(): GatewaySessionRow {
  return {
    key: "agent:main:mine",
    agentId: "main",
    kind: "direct",
    label: "My session",
    owner: { actor: viewer },
  };
}

it.each(["visible", "bounded"])(
  "keeps solo legacy sessions and settles when their participants are %s",
  async (participants) => {
    const legacy: GatewaySessionRow = {
      key: "agent:main:legacy",
      agentId: "main",
      kind: "direct",
      label: "Legacy session",
      participants:
        participants === "visible" ? [{ identity: { type: "agent", id: "research" } }] : [],
      participantCount: 1,
    };
    const fixture = await mountOwnerQuery([ownSession(), legacy], [viewer]);
    try {
      await fixture.settle();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.ownerId).toBeUndefined();
      expect(fixture.sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
      expect(
        fixture.sidebar.querySelector('[data-session-key="agent:main:legacy"]'),
      ).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  },
);

it("settles with multiple owners and keeps an explicitly selected owner's empty list", async () => {
  const fixture = await mountOwnerQuery(
    [ownSession()],
    [viewer, { type: "human", id: "other", label: "Other" }],
  );
  try {
    await fixture.settle();
    expect(fixture.requests.length).toBeLessThanOrEqual(2);
    expect(fixture.requests.at(-1)?.ownerId).toBe("viewer");
    expect(fixture.sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();

    await fixture.sidebar.sidebarMenus.preloadMenuRenderer();
    await selectSessionMenuValue(fixture.sidebar, "owner:other");
    await fixture.settle();
    expect(fixture.requests.at(-1)?.ownerId).toBe("other");
    expect(fixture.requests.length).toBeLessThanOrEqual(3);
    expect(fixture.sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
    expect(fixture.sidebar.querySelector("#sidebar-session-owner-title")?.textContent).toContain(
      "Other",
    );
  } finally {
    await fixture.dispose();
  }
});

it("does not include an agent's sessions when its ID equals the signed-in human's ID", async () => {
  const agent = { type: "agent" as const, id: viewer.id, label: "Agent" };
  const fixture = await mountOwnerQuery([{ ...ownSession(), owner: { actor: agent } }], [agent]);
  try {
    await fixture.settle();
    expect(fixture.requests.length).toBeLessThanOrEqual(2);
    expect(fixture.requests.at(-1)?.ownerId).toBe("viewer");
    expect(fixture.sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
  } finally {
    await fixture.dispose();
  }
});
