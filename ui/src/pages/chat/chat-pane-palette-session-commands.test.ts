/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command palette session commands", () => {
  function fixture(rowPatch: Partial<GatewaySessionRow> = {}) {
    const client = createGatewayBrowserClientFixture();
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "current-id",
      kind: "direct",
      ...rowPatch,
    };
    const result = {
      ts: 1,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [row],
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
    pane.onPaneSessionChange = vi.fn();
    return { pane, state, patch, row };
  }

  function listed(pane: ReturnType<typeof fixture>["pane"]) {
    return pane.commandPaletteSessionCommands.list().map(({ kind, label }) => [kind, label]);
  }

  it("offers the header menu's single-session actions for the pane's session", () => {
    const { pane } = fixture();
    expect(listed(pane)).toEqual([
      ["toggle-pin", t("sessionsView.pinSession")],
      ["rename", t("sessionsView.renameSession")],
      ["toggle-unread", t("sessionsView.markUnread")],
      ["toggle-archived", t("sessionsView.archiveSession")],
      ["fork", t("sessionsView.forkSession")],
      ["delete", t("sessionsView.deleteSession")],
    ]);
  });

  it("names the inverse action for pinned and unread sessions", () => {
    const { pane } = fixture({ pinned: true, unread: true });
    expect(listed(pane)).toEqual([
      ["toggle-pin", t("sessionsView.unpinSession")],
      ["rename", t("sessionsView.renameSession")],
      ["toggle-unread", t("sessionsView.markRead")],
      ["toggle-archived", t("sessionsView.archiveSession")],
      ["fork", t("sessionsView.forkSession")],
      ["delete", t("sessionsView.deleteSession")],
    ]);
  });

  it("offers Restore instead of Archive and Pin for an archived session", () => {
    const { pane } = fixture({ archived: true });
    expect(listed(pane).map(([kind]) => kind)).not.toContain("toggle-pin");
    expect(listed(pane)).toContainEqual(["toggle-archived", t("sessionsView.restoreSession")]);
  });

  it("omits lifecycle actions the header menu disables for the main session", () => {
    const { pane } = fixture({ key: "agent:main:main" });
    const kinds = listed(pane).map(([kind]) => kind);
    expect(kinds).toContain("rename");
    expect(kinds).not.toContain("toggle-archived");
    expect(kinds).not.toContain("delete");
  });

  it("omits Rename where the pane has no header to edit", () => {
    const { pane } = fixture();
    pane.compact = true;
    expect(listed(pane).map(([kind]) => kind)).not.toContain("rename");
  });

  it.each(["inactive", "hidden", "onboarding", "offline", "missing-row", "read-only", "catalog"])(
    "offers nothing during %s",
    (guard) => {
      // Imported catalog transcripts are read through the pane, not Gateway sessions.
      const { pane, state } = fixture(
        guard === "catalog" ? { key: "agent:main:catalog:claude-code:host-1:thread-1" } : {},
      );
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
      expect(listed(pane)).toEqual([]);
    },
  );

  it("archives through the header lifecycle with Undo", async () => {
    const { pane, patch, row } = fixture();
    vi.mocked(showToast).mockClear();
    pane.commandPaletteSessionCommands.run("toggle-archived");
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
    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
  });

  it("starts the header rename for the pane's session", () => {
    const { pane } = fixture({ label: "Current label" });
    pane.commandPaletteSessionCommands.run("rename");
    expect(pane.headerEditing).toBe(true);
    expect(pane.headerRenameValue).toBe("Current label");
  });

  it.each(["read-only", "hidden"])("rechecks a listed command when it runs: %s", async (guard) => {
    const { pane, patch } = fixture();
    expect(listed(pane).map(([kind]) => kind)).toContain("toggle-pin");
    if (guard === "read-only") {
      pane.context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
    } else {
      pane.presented = false;
    }
    pane.commandPaletteSessionCommands.run("toggle-pin");
    await vi.dynamicImportSettled();
    expect(patch).not.toHaveBeenCalled();
  });
});
