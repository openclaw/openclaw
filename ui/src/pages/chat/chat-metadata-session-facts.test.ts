import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { revalidateChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { makeChatHost, makeRequestMock, requestCalls } from "./chat-host.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatMetadata, retireChatMetadataRequests } from "./chat-state-refresh.ts";
import { ChatPermissionPicker } from "./components/chat-permission-picker.tsx";

afterEach(() => vi.useRealTimers());

function sessionRow(key: string, overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    sessionId: "current-session",
    kind: "direct",
    updatedAt: 1,
    contextTokens: 8192,
    ...overrides,
  };
}

function metadataHost(
  request: Parameters<typeof createTestGatewayClient>[0],
  sessionKey: string,
  overrides: Partial<ChatPageHost> = {},
) {
  const client = createTestGatewayClient(request);
  const harness = createGatewayHarness(client);
  const sessions = createTestSessionCapability(harness.gateway, "work");
  const state = {
    ...makeChatHost(),
    client,
    sessions,
    sessionKey,
    assistantAgentId: "work",
    connected: true,
    ...overrides,
  } as unknown as ChatPageHost;
  onTestFinished(() => retireChatMetadataRequests(state));
  return { client, sessions, state, ...harness };
}

it.each(["agent:work:current", "global"])(
  "refreshes catalog-dependent facts for %s without reloading retained roster windows",
  async (key) => {
    vi.useFakeTimers();
    const before = sessionRow(key, {
      agentId: "work",
      model: "model",
      modelProvider: "test",
      permissionMode: "workspace",
    });
    const after: GatewaySessionRow = {
      ...before,
      contextTokens: 262144,
      permissionMode: "guarded",
    };
    const other: GatewaySessionRow = {
      key: "agent:other:kept",
      sessionId: "other-session",
      kind: "direct",
      updatedAt: 1,
    };
    const query = { agentId: "work", spawnedBy: key, limit: 10000 };
    let permissionReadbackUnavailable = false;
    let currentRow = before;
    const request = makeRequestMock({
      "chat.metadata": { commands: [] },
      "sessions.describe": () => ({ session: currentRow }),
      "sessions.patch": () => {
        throw new Error("Permission application failed");
      },
      "sessions.list": (params: unknown) => {
        const otherAgent = (params as { agentId?: string }).agentId === "other";
        if (!otherAgent && permissionReadbackUnavailable) {
          throw new Error("Permission readback unavailable");
        }
        return sessionsResult(otherAgent ? [other] : [currentRow], 1);
      },
    });
    const { client, emitEvent, sessions, state } = metadataHost(request, key, {
      connectionEpoch: 1,
      chatModelSwitchPromises: {},
    });
    const lists = () => requestCalls(request, "sessions.list");
    const observation = sessions.observeList(query, () => {});
    onTestFinished(() => observation.dispose());
    await sessions.refresh({ agentId: "other" });
    await observation.refresh();
    state.sessionsResult = sessionsResult([before], 1);
    state.sessionsResultAgentId = "work";
    await refreshChatMetadata(state);
    const writeAccess = { allowed: true, requiredScope: "operator.write" } as const;
    const controls = () =>
      renderChatPaneComposerControls({
        state,
        selectedSession: state.sessionsResult?.sessions[0],
        agentDefaultModel: undefined,
        modelAccess: writeAccess,
        effortAccess: writeAccess,
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
        permissionAccess: writeAccess,
        canSelectFull: true,
        onModelSetup: vi.fn(),
      });
    const container = document.createElement("div");
    permissionReadbackUnavailable = true;
    await controls().permissionPicker.onSelect("full");
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({
        key,
        permissionMode: "full",
        expectedSessionId: before.sessionId,
      }),
    );
    expect(state.chatError).toContain("Failed to update permissions");
    const view = mountSolid(ChatPermissionPicker, controls().permissionPicker, container);
    const picker = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
    expect(picker.getAttribute("aria-label")).toContain(
      t("chat.permissionControls.modes.full.label"),
    );
    expect(picker.disabled).toBe(false);
    await expect(observation.refresh()).rejects.toThrow("Permission readback unavailable");
    permissionReadbackUnavailable = false;
    currentRow = after;
    const primaryRevision = sessions.canonicalListRevision;
    const initialLists = lists().length;
    invalidateChatMetadataStore(client);
    await refreshChatMetadata(state);
    await vi.advanceTimersByTimeAsync(1000);
    for (const result of [state.sessionsResult, sessions.listSnapshot(query).result]) {
      expect(result?.sessions[0]).toMatchObject(after);
    }
    expect(sessions.canonicalListRevision).toBe(primaryRevision);
    expect(sessions.state.agentId).toBe("other");
    expect(sessions.state.result?.sessions).toEqual([other]);
    expect(lists()).toHaveLength(initialLists);
    view.update(controls().permissionPicker);
    expect(picker.getAttribute("aria-label")).toContain(
      t("chat.permissionControls.modes.guarded.label"),
    );
    expect(picker.disabled).toBe(false);
    expect(request).toHaveBeenCalledWith("sessions.describe", { key, agentId: "work" });
    // Actual membership events still refresh the matching windows.
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { key: "agent:work:new", agentId: "work", reason: "create", spawnedBy: key },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lists().length).toBeGreaterThan(initialLists);
    const afterMembership = lists().length;
    emitEvent({ type: "event", event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lists()).toHaveLength(afterMembership + 2);
  },
);

it("does not publish a catalog descriptor after the chat changes its session", async () => {
  const described = createDeferred<{ session: GatewaySessionRow }>();
  const row = sessionRow("agent:work:old", { sessionId: "old-session" });
  const request = makeRequestMock({
    "chat.metadata": { commands: [] },
    "sessions.describe": () => described.promise,
  });
  const { client, state } = metadataHost(request, row.key, {
    sessionsResult: sessionsResult([row], 1),
  });
  onTestFinished(() => described.resolve({ session: row }));
  await refreshChatMetadata(state);
  invalidateChatMetadataStore(client);
  const pending = refreshChatMetadata(state);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("sessions.describe", { key: row.key, agentId: "work" }),
  );
  const replacement = sessionsResult(
    [{ ...row, key: "agent:work:new", sessionId: "new-session" }],
    2,
  );
  state.sessionKey = "agent:work:new";
  state.sessionsResult = replacement;
  described.resolve({ session: { ...row, contextTokens: 262144 } });
  await pending;
  expect(state.sessionsResult).toBe(replacement);
});

it.each(["direct command revalidation", "scoped invalidation"] as const)(
  "converges pending descriptor facts after %s retires the old read",
  async (retirement) => {
    const oldFacts = createDeferred<{ session: GatewaySessionRow }>();
    const freshFacts = createDeferred<{ session: GatewaySessionRow }>();
    const oldCommands = createDeferred<{ commands: [] }>();
    const before = sessionRow("agent:work:current", { agentId: "work" });
    const after = { ...before, contextTokens: 262144 };
    let describes = 0;
    let holdCommands = false;
    let commandReads = 0;
    const request = makeRequestMock({
      "sessions.describe": () => (++describes === 1 ? oldFacts.promise : freshFacts.promise),
      "sessions.list": () => sessionsResult([before], 1),
      "chat.metadata": () =>
        holdCommands && ++commandReads === 1 ? oldCommands.promise : { commands: [] },
    });
    const { client, sessions, state } = metadataHost(request, before.key, {
      sessionsResultAgentId: "work",
    });
    await sessions.refresh({ agentId: "work" });
    state.sessionsResult = sessions.state.result;
    onTestFinished(() => {
      oldCommands.resolve({ commands: [] });
      oldFacts.resolve({ session: before });
      freshFacts.resolve({ session: after });
    });
    await refreshChatMetadata(state);
    const lists = requestCalls(request, "sessions.list").length;
    holdCommands = retirement === "scoped invalidation";
    invalidateChatMetadataStore(client);
    await vi.waitFor(() => expect(describes).toBe(1));
    if (retirement === "scoped invalidation") {
      invalidateChatMetadataStore(client, { agentId: "work", sessionKey: before.key });
    } else {
      await revalidateChatMetadata(client, { agentId: "work", sessionKey: before.key });
    }
    oldFacts.resolve({ session: { ...before, contextTokens: 16384 } });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(8192);
    oldCommands.resolve({ commands: [] });
    await vi.waitFor(() => expect(describes).toBe(2));
    freshFacts.resolve({ session: after });
    await vi.waitFor(() => expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(262144));
    expect(sessions.state.result?.sessions[0]?.contextTokens).toBe(262144);
    expect(requestCalls(request, "sessions.list")).toHaveLength(lists);
    expect(describes).toBe(2);
  },
);
