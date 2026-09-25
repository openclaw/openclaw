/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("direct session archive shortcuts", () => {
  function fixture(rowPatch: Partial<GatewaySessionRow> = {}) {
    const client = createGatewayBrowserClientFixture();
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "current-id",
      kind: "direct",
      ...rowPatch,
    };
    const other: GatewaySessionRow = {
      key: "agent:main:other",
      sessionId: "other-id",
      kind: "direct",
    };
    const result = {
      ts: 1,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [row, other],
    };
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({
      patch,
      state: { result, error: null },
      captureConnectionScope: () => ({ client, epoch: 1 }),
      isConnectionScopeCurrent: () => true,
      invalidate: vi.fn(),
      refreshReplacement: vi.fn(async () => result),
    });
    const { pane, state } = createTestChatPane({ client, sessions });
    pane.active = true;
    state.sessionKey = row.key;
    state.sessionsResult = result;
    state.chatMessage = "Keep the unsent foreground draft";
    pane.onPaneSessionChange = vi.fn();
    return { pane, state, sessions, patch, row, other };
  }

  function press(pane: TestChatPane, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", {
      key: "A",
      code: "KeyA",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
      ...init,
    });
    pane.handleDocumentKeydown(event);
    return event;
  }

  it("uses the header lifecycle and Undo for the current session via the keyboard", async () => {
    const { pane, state, patch, row } = fixture();
    vi.mocked(showToast).mockClear();
    const event = press(pane);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ actionLabel: t("common.undo") }),
      ),
    );
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      row.key,
      { archived: true },
      { agentId: "main", expectedSessionId: row.sessionId },
    );
    expect(state.chatMessage).toBe("Keep the unsent foreground draft");
    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction?.();
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        row.key,
        { archived: false },
        { agentId: "main", expectedSessionId: row.sessionId, deferListRefresh: true },
      ),
    );
  });

  it("deduplicates rapid requests through the shared archive owner", async () => {
    const { pane, patch, sessions, row } = fixture();
    const pending = createDeferred<Record<string, never>>();
    patch.mockImplementation(() => pending.promise);
    press(pane);
    press(pane);
    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(sessions.archiveVisibility(row.key)).toBe("pending");
    expect(press(pane).defaultPrevented).toBe(false);
    pending.resolve({});
    await vi.waitFor(() => expect(sessions.archiveVisibility(row.key)).toBeUndefined());
    expect(patch).toHaveBeenCalledOnce();
  });

  it.each([
    { key: "main" },
    { key: "agent:main:main" },
    { key: "global", kind: "global" },
    { key: "unknown", kind: "unknown" },
    { archived: true },
    { sessionId: undefined },
  ] satisfies Partial<GatewaySessionRow>[])(
    "does not archive protected, archived, or non-durable rows: %j",
    async (row) => {
      const { pane, patch } = fixture(row);
      expect(press(pane).defaultPrevented).toBe(false);
      await vi.dynamicImportSettled();
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "inactive",
    "hidden",
    "modal",
    "onboarding",
    "offline",
    "read-only",
    "unavailable",
    "missing-row",
  ])("does not act during %s", async (guard) => {
    const { pane, state, patch } = fixture();
    const modal = document.createElement("div");
    if (guard === "inactive") {
      pane.active = false;
    }
    if (guard === "hidden") {
      pane.presented = false;
    }
    if (guard === "onboarding") {
      pane.onboarding = true;
    }
    if (guard === "offline") {
      state.connected = false;
    }
    if (guard === "missing-row") {
      state.sessionsResult = null;
    }
    if (guard === "read-only") {
      pane.context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
    }
    if (guard === "unavailable") {
      pane.context.gateway.snapshot.hello!.features!.methods = [];
    }
    if (guard === "modal") {
      (document.openClawModalLayers ??= new Set()).add(modal);
    }
    try {
      expect(press(pane).defaultPrevented).toBe(false);
      await vi.dynamicImportSettled();
      expect(patch).not.toHaveBeenCalled();
    } finally {
      document.openClawModalLayers?.delete(modal);
    }
  });

  it.each([
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { key: "Dead" },
    { altKey: true },
  ])("leaves repetition, composition, and other chords alone: %j", async (init) => {
    const { pane, patch } = fixture();
    expect(press(pane, init).defaultPrevented).toBe(false);
    await vi.dynamicImportSettled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("rechecks live authority after loading the action implementation", async () => {
    const { pane, patch } = fixture();
    expect(press(pane).defaultPrevented).toBe(true);
    pane.context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
    await vi.dynamicImportSettled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not archive after the originating pane loses presentation during lazy loading", async () => {
    const { pane, patch } = fixture();
    expect(press(pane).defaultPrevented).toBe(true);
    pane.presented = false;
    await vi.dynamicImportSettled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps the draft and reports archive failure without navigating or offering Undo", async () => {
    const { pane, state, patch, sessions, row } = fixture();
    vi.mocked(showToast).mockClear();
    patch.mockRejectedValue(new Error("Archive rejected"));
    expect(press(pane).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(state.chatError).toContain("Archive rejected"));
    expect(state.chatMessage).toBe("Keep the unsent foreground draft");
    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(sessions.archiveVisibility(row.key)).toBeUndefined();
  });
});
