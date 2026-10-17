import { expect } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  createSessionState,
  mountSidebar,
} from "../app-sidebar.ts";

export function sessionFixture(keys: string[]) {
  const harness = createSessionsHarness("main", keys);
  const result = harness.sessions.state.result!;
  return {
    ...harness,
    result,
    row: (key: string, fields: Partial<GatewaySessionRow> = {}) =>
      Object.assign(
        result.sessions.find((row) => row.key === key)!,
        fields,
      ),
    mount: async (
      gateway = createGatewayHarness({} as GatewayBrowserClient).gateway,
      agents?: Parameters<typeof mountSidebar>[3],
    ) => {
      const mounted = await mountSidebar(gateway, harness.sessions, "panel", agents);
      return {
        ...mounted,
        query: <T extends Element = Element>(key: string, selector = "") =>
          sessionQuery<T>(mounted.sidebar, key, selector),
      };
    },
  };
}

export function sessionResult(keys: string[], agentId = "main") {
  return createSessionState(agentId, keys).result!;
}

export function sessionList(
  sessions: GatewaySessionRow[],
  overrides: Partial<SessionsListResult> = {},
): SessionsListResult {
  return {
    ts: 2,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
    ...overrides,
  };
}

export function human(label: string) {
  return { type: "human" as const, id: `profile-${label.toLowerCase()}`, label };
}

export function sessionQuery<T extends Element = Element>(
  root: ParentNode,
  key: string,
  selector = "",
) {
  return root.querySelector<T>(`[data-session-key="${key}"]${selector ? ` ${selector}` : ""}`);
}

export function expectAbsent(root: ParentNode | null | undefined, ...selectors: string[]) {
  for (const selector of selectors) {
    expect(root?.querySelector(selector)).toBeNull();
  }
}

export function describedText(element: Element) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");
}
