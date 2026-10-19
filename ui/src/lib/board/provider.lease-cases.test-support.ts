import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { acquireBoardProviderForSession, mcpAppWidgetNameForViewId } from "./provider.ts";
import type { BoardSnapshot, BoardWidget } from "./types.ts";

export function boardWidget(name: string, overrides: Partial<BoardWidget> = {}): BoardWidget {
  return {
    name,
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
    ...overrides,
  };
}

export function boardSnapshot(
  sessionKey: string,
  revision = 1,
  overrides: Partial<BoardSnapshot> = {},
): BoardSnapshot {
  return { sessionKey, revision, tabs: [], widgets: [], ...overrides };
}

export const mainTab = { tabId: "main", title: "Main", position: 0, chatDock: "right" as const };

export function boardClient(request: GatewayRequestHandler) {
  let listener: ((event: GatewayEventFrame) => void) | undefined;
  return {
    request: request as never,
    addEventListener(next: (event: GatewayEventFrame) => void) {
      listener = next;
      return () => {};
    },
    emit(event: string, payload: unknown) {
      listener?.({ type: "event", event, payload });
    },
  };
}

export const capabilities = {
  canMutate: true,
  canGrant: true,
  canPinWidgets: true,
  canPinMcpApps: true,
};
export const noCapabilities = {
  canMutate: false,
  canGrant: false,
  canPinWidgets: false,
  canPinMcpApps: false,
};

export function acquireLease(
  session: Parameters<typeof acquireBoardProviderForSession>[0],
  client: Parameters<typeof acquireBoardProviderForSession>[1],
  { canMutate = true, canGrant = true, canPinWidgets = true, canPinMcpApps = true } = {},
  scope?: object,
) {
  return acquireBoardProviderForSession(
    session,
    client,
    true,
    canPinWidgets,
    canPinMcpApps,
    canMutate,
    canGrant,
    scope,
  );
}

export function registerBoardProviderLeaseCases(): void {
  it("retains same-owner reconnect data but isolates replacement identity from retiring board leases", async () => {
    const session = { sessionKey: "agent:main:presentation-owner" };
    const initial = { ...session, revision: 1, tabs: [], widgets: [] };
    const refreshed = createDeferred<typeof initial>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(initial)
      .mockReturnValue(refreshed.promise);
    const client = createTestGatewayClient(request);
    const firstScope = {};
    const first = acquireLease(session, client, {}, firstScope);
    const retiring = acquireLease(session, client, {}, firstScope);
    let replacement: ReturnType<typeof acquireBoardProviderForSession> | undefined;
    try {
      await vi.waitFor(() => expect(first.provider.snapshot$.value.revision).toBe(1));
      expect(retiring.provider.snapshot$).toBe(first.provider.snapshot$);
      first.update(client, false, capabilities);
      expect(first.provider.snapshot$.value.revision).toBe(1);
      expect(first.provider.canMutate).toBe(false);
      await expect(first.provider.applyOps([])).rejects.toThrow("mutation unavailable");
      first.update(client, true, capabilities);
      expect(first.provider.snapshot$.value.revision).toBe(1);

      replacement = acquireLease(session, client, {}, {});
      expect(replacement.provider.hasLoadedSnapshot).toBe(false);
      expect(replacement.provider.snapshot$.value.revision).toBe(0);
      expect(first.provider.canMutate).toBe(false);
      expect(retiring.provider.canGrant).toBe(false);
      await expect(retiring.provider.applyOps([])).rejects.toThrow("mutation unavailable");
      retiring.update(client, true, capabilities);
      refreshed.resolve({ ...initial, revision: 2 });
      await vi.waitFor(() => expect(replacement!.provider.snapshot$.value.revision).toBe(2));
      expect(retiring.provider.snapshot$.value.revision).toBe(1);
      first.release();
      retiring.release();
      expect(replacement.provider.canMutate).toBe(true);
      expect(request).not.toHaveBeenCalledWith("board.update", expect.anything());
    } finally {
      first.release();
      retiring.release();
      replacement?.release();
    }
  });

  it("keeps retired gateway clients from rolling back shared board leases", async () => {
    const sessionKey = "agent:main:monotonic-board-lease";
    const createClient = (revision: number) => {
      const snapshot = { sessionKey, revision, tabs: [], widgets: [] };
      const requests = vi.fn(async () => snapshot);
      const listeners = new Set<(event: GatewayEventFrame) => void>();
      const addEventListener = vi.fn((listener: (event: GatewayEventFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      });
      return {
        snapshot,
        requests,
        listeners,
        addEventListener,
        request: requests as never,
      };
    };
    const previous = createClient(1);
    const current = createClient(2);
    const future = createClient(3);
    const writer = acquireBoardProviderForSession({ sessionKey }, previous);
    const stale = acquireBoardProviderForSession({ sessionKey }, previous);

    try {
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(previous.snapshot));
      const retiredListener = [...previous.listeners][0];
      expect(retiredListener).toBeDefined();

      writer.update(current, true, capabilities);
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(current.snapshot));
      expect(stale.provider.snapshot$.value).toEqual(current.snapshot);
      expect(previous.listeners.size).toBe(0);
      expect(current.listeners.size).toBe(1);

      stale.update(previous, false, capabilities);
      expect(writer.provider.snapshot$.value).toEqual(current.snapshot);
      expect(stale.provider.snapshot$.value).toEqual(current.snapshot);
      expect(previous.addEventListener).toHaveBeenCalledOnce();
      expect(previous.requests).toHaveBeenCalledOnce();
      expect(current.listeners.size).toBe(1);

      retiredListener?.({
        type: "event",
        event: "board.changed",
        payload: { sessionKey, revision: 4 },
      });
      await Promise.resolve();
      expect(current.requests).toHaveBeenCalledOnce();

      await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
      expect(current.requests).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(previous.requests).toHaveBeenCalledOnce();

      writer.update(current, false, capabilities);
      writer.update(current, true, capabilities);
      await vi.waitFor(() => expect(current.requests).toHaveBeenCalledTimes(3));
      expect(writer.provider.snapshot$.value).toEqual(current.snapshot);

      stale.update(future, true, capabilities);
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(future.snapshot));
      expect(stale.provider.snapshot$.value).toEqual(future.snapshot);
      expect(current.listeners.size).toBe(0);
      expect(future.listeners.size).toBe(1);

      await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
      expect(future.requests).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(previous.requests).toHaveBeenCalledOnce();
    } finally {
      writer.release();
      stale.release();
    }
  });

  it.each(["dashboard-first"] as const)(
    "isolates concurrent board lease capabilities in %s order",
    async (order) => {
      const sessionKey = `agent:main:lease-capabilities-${order}`;
      const snapshot = { sessionKey, revision: 1, tabs: [], widgets: [] };
      const removeListener = vi.fn();
      const client = {
        request: vi.fn(async () => snapshot) as never,
        addEventListener: vi.fn(() => removeListener),
      };
      const first = acquireLease({ sessionKey }, client, noCapabilities);
      const second = acquireLease({ sessionKey }, client);
      const chat = second;
      const dashboard = first;

      try {
        await vi.waitFor(() => expect(chat.provider.snapshot$.value).toEqual(snapshot));

        expect(chat.provider).not.toBe(dashboard.provider);
        expect(chat.provider.snapshot$).toBe(dashboard.provider.snapshot$);
        expect(chat.provider.events).toBe(dashboard.provider.events);
        expect(chat.provider).toMatchObject(capabilities);
        expect(dashboard.provider).toMatchObject(noCapabilities);
        expect(client.request).toHaveBeenCalledOnce();
        expect(client.addEventListener).toHaveBeenCalledOnce();

        await expect(chat.provider.applyOps([])).resolves.toBeUndefined();
        await expect(chat.provider.pinWidget({ docId: "cv-allowed" })).resolves.toBeUndefined();
        await expect(chat.provider.pinMcpApp({ viewId: "app-allowed" })).resolves.toBeUndefined();
        await expect(dashboard.provider.pinWidget({ docId: "cv-denied" })).rejects.toThrow();
        await expect(dashboard.provider.pinMcpApp({ viewId: "app-denied" })).rejects.toThrow();

        expect(client.request).toHaveBeenCalledTimes(4);
        expect(client.request).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
        expect(client.request).toHaveBeenCalledWith("board.widget.put", {
          sessionKey,
          name: "canvas-cv-allowed",
          content: { kind: "canvas-doc", docId: "cv-allowed" },
        });
        expect(client.request).toHaveBeenCalledWith("board.widget.put", {
          sessionKey,
          name: mcpAppWidgetNameForViewId("app-allowed"),
          content: { kind: "mcp-app", viewId: "app-allowed" },
        });

        first.release();
        first.release();
        expect(removeListener).not.toHaveBeenCalled();
        expect(second.provider.snapshot$.value).toEqual(snapshot);
        await expect(first.provider.applyOps([])).rejects.toThrow();
        expect(client.request).toHaveBeenCalledTimes(4);
        second.release();
        expect(removeListener).toHaveBeenCalledOnce();
      } finally {
        first.release();
        second.release();
      }
    },
  );

  it("enforces write and approval scopes separately for concurrent board leases", async () => {
    const sessionKey = "agent:main:independent-board-scopes";
    const snapshot = boardSnapshot(sessionKey, 1, {
      tabs: [{ ...mainTab, title: t("chat.board.defaultTab") }],
      widgets: [boardWidget("pending-widget", { grantState: "pending" })],
    });
    const client = {
      request: vi.fn(async () => snapshot) as never,
      addEventListener: vi.fn(() => () => {}),
    };
    const writer = acquireLease({ sessionKey }, client, { canGrant: false });
    const approver = acquireLease({ sessionKey }, client, {
      canPinWidgets: false,
      canPinMcpApps: false,
      canMutate: false,
    });

    try {
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(snapshot));

      await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
      await expect(writer.provider.grant("pending-widget", "granted")).rejects.toThrow();
      await expect(approver.provider.applyOps([])).rejects.toThrow();
      await expect(approver.provider.pinWidget({ docId: "cv-restricted" })).rejects.toThrow();
      await expect(approver.provider.pinMcpApp({ viewId: "app-restricted" })).rejects.toThrow();
      await expect(approver.provider.grant("pending-widget", "granted")).resolves.toBeUndefined();

      expect(client.request).toHaveBeenCalledTimes(3);
      expect(client.request).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(client.request).toHaveBeenCalledWith("board.widget.grant", {
        sessionKey,
        name: "pending-widget",
        decision: "granted",
        revision: 1,
      });
      expect(client.addEventListener).toHaveBeenCalledOnce();
    } finally {
      writer.release();
      approver.release();
    }
  });
}
