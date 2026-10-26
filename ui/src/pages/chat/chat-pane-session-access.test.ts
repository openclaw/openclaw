/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createModalDialogTestFixture,
  submitInputDialog,
  waitForInputDialog,
} from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createPaneHeaderWorkspaceFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import {
  openNativeMenu,
  renderPaneHeaderInto,
} from "./components/chat-pane-header.test-support.ts";

const sessionRow = (overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: "agent:main:current",
  kind: "direct",
  updatedAt: 0,
  ...overrides,
});
const hello = (
  scope = "operator.write",
  methods = ["sessions.patch"],
): NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]> => ({
  type: "hello-ok",
  protocol: 3,
  auth: { role: "operator", scopes: [scope] },
  features: { methods },
});
function createPatchPane(response: object = {}) {
  const patch = vi.fn(async () => response);
  return {
    patch,
    ...createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    }),
  };
}
function renderSharingHeader(
  pane: ReturnType<typeof createTestChatPane>["pane"],
  state: ReturnType<typeof createTestChatPane>["state"],
  connected = false,
) {
  const container = document.createElement("div");
  if (connected) {
    document.body.append(container);
    onTestFinished(() => container.remove());
  }
  renderPaneHeaderInto(
    pane.renderPaneHeader(
      createPaneHeaderWorkspaceFixture(state),
      sessionRow({ sharingRole: "owner", visibility: "shared" }),
      false,
      undefined,
      false,
      null,
    ),
    container,
  );
  return container;
}

async function createHeaderDraftPane(row: GatewaySessionRow) {
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({
      request: async (method) => {
        switch (method) {
          case "agents.list":
            return makeBootRoster();
          case "sessions.list":
            return sessionsResult([row], 1);
          case "sessions.describe":
            return { session: row };
          case "chat.startup":
            return { messages: [] };
          default:
            return {};
        }
      },
    }),
  });
  fixture.state.loadAssistantIdentity = vi.fn(async () => undefined);
  fixture.state.sessionsResult = await fixture.sessions.list({ agentId: "main" });
  fixture.state.sessionsResultAgentId = "main";
  const patch = vi.spyOn(fixture.sessions, "patch").mockResolvedValue({
    ok: true,
    path: "",
    key: row.key,
    entry: { sessionId: row.sessionId ?? "current-session" },
  });
  const groupsPut = vi.spyOn(fixture.sessions, "groupsPut").mockResolvedValue("completed");
  return { ...fixture, patch, groupsPut };
}

describe("chat pane session access", () => {
  it.each([
    {
      scope: "operator.read",
      sessionKey: "agent:main:current",
      required: "operator.sessions.write",
    },
    {
      scope: "operator.write",
      sessionKey: "agent:main:dashboard:incognito-current",
      required: "operator.admin",
    },
  ])(
    "refuses creation from $sessionKey without $required",
    async ({ scope, sessionKey, required }) => {
      const sessions = {
        create: vi.fn(async () => "agent:main:new"),
      } as unknown as SessionCapability;
      const client = {} as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({ client, sessions });
      state.sessionKey = sessionKey;
      pane.context.gateway.snapshot.hello = hello(scope, ["sessions.create"]);

      await expect(pane.createSession()).resolves.toBe(false);

      expect(sessions.create).not.toHaveBeenCalled();
      expect(state.lastError).toContain(required);
      expect(state.chatError).toBe(state.lastError);
    },
  );

  it("refuses header rename when sessions.patch is unavailable or lacks write scope", () => {
    for (const snapshot of [hello("operator.write", ["sessions.create"]), hello("operator.read")]) {
      const { pane, state, patch } = createPatchPane();
      pane.context.gateway.snapshot.hello = snapshot;

      pane.beginHeaderRename(sessionRow());

      expect(Boolean(pane.headerPresentation.renameSession)).toBe(false);
      expect(state.chatError).toBeTruthy();
      expect(patch).not.toHaveBeenCalled();
    }
  });

  it("rechecks header rename access before committing", () => {
    const { pane, state, patch } = createPatchPane();

    pane.beginHeaderRename(sessionRow());
    pane.headerPresentation.renameValue = "Blocked rename";
    pane.context.gateway.snapshot.hello = hello("operator.read");
    pane.commitHeaderRename();

    expect(state.chatError).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("retains inline rename text through a blip without submitting offline", async () => {
    const session = sessionRow();
    const { pane, patch } = await createHeaderDraftPane(session);
    const connected = { ...pane.context.gateway.snapshot };
    pane.beginHeaderRename(session);
    pane.headerPresentation.renameValue = "Still editing";

    Object.assign(pane.context.gateway.snapshot, { phase: "reconnecting", hello: null });
    pane.applyGatewaySnapshot(pane.context.gateway.snapshot);
    pane.commitHeaderRename();
    expect(pane.headerPresentation.renameValue).toBe("Still editing");
    expect(pane.headerPresentation.renameSession).not.toBeNull();
    expect(patch).not.toHaveBeenCalled();

    Object.assign(pane.context.gateway.snapshot, connected);
    pane.applyGatewaySnapshot(pane.context.gateway.snapshot);
    expect(pane.headerPresentation.renameSession).not.toBeNull();
    expect(pane.headerPresentation.renameValue).toBe("Still editing");

    pane.context.gateway.snapshot.hello = {
      ...connected.hello,
      auth: { role: "operator", scopes: ["operator.read"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.applyGatewaySnapshot(pane.context.gateway.snapshot);
    expect(pane.headerPresentation.renameSession).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it.each(["client", "account", "recovery scope"] as const)(
    "keeps header drafts through reconnect and retires them with %s identity",
    async (change) => {
      const modal = createModalDialogTestFixture();
      const row = sessionRow({ sessionId: "current-session", sharingRole: "owner" });
      const { pane, patch, groupsPut } = await createHeaderDraftPane(row);
      const connected = {
        ...pane.context.gateway.snapshot,
        selfUser: { id: "alice", name: "Alice" },
      };
      pane.applyGatewaySnapshot(connected);
      const open = () => modal.track(pane.handleHeaderSessionAction({ kind: "new-group" }, row));
      try {
        const completion = open();
        const input = await waitForInputDialog();
        input.value = "Unsent group";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting", hello: null });
        flush();
        expect(document.body.querySelector("openclaw-modal-dialog input")).toBe(input);
        expect(input.value).toBe("Unsent group");
        expect(input.disabled).toBe(false);
        expect(
          input.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')
            ?.disabled,
        ).toBe(true);
        input
          .closest("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        expect(groupsPut).not.toHaveBeenCalled();
        expect(patch).not.toHaveBeenCalled();

        pane.applyGatewaySnapshot(connected);
        await submitInputDialog("Unsent group");
        await completion;
        expect(groupsPut).toHaveBeenCalledWith(["Unsent group"]);
        expect(patch).toHaveBeenCalledWith(
          row.key,
          { category: "Unsent group" },
          { agentId: "main", expectedSessionId: row.sessionId },
        );

        const retired = open();
        await waitForInputDialog();
        pane.beginHeaderRename(row);
        pane.headerPresentation.renameValue = "Private title";
        pane.applyGatewaySnapshot({
          ...connected,
          ...(change === "client"
            ? {
                client: createGatewayBrowserClientFixture(),
                phase: "reconnecting" as const,
                hello: null,
              }
            : change === "account"
              ? { selfUser: { id: "bob", name: "Bob" } }
              : {
                  selfUser: undefined,
                  hello: {
                    ...connected.hello!,
                    auth: { ...connected.hello!.auth!, recoveryScope: "bob-scope" },
                  },
                }),
        });
        await retired;
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
        expect(pane.headerPresentation.renameSession).toBeNull();
        pane.commitHeaderRename();
        expect(patch).toHaveBeenCalledTimes(1);
      } finally {
        await modal.cleanup();
      }
    },
  );

  it.each(["failed", "stale"] as const)(
    "keeps the header group draft after a %s assignment",
    async (outcome) => {
      const modal = createModalDialogTestFixture();
      const row = sessionRow({ sessionId: "current-session" });
      const { pane, patch } = await createHeaderDraftPane(row);
      patch.mockImplementationOnce(async () => {
        if (outcome === "stale") {
          pane.applyGatewaySnapshot({
            ...pane.context.gateway.snapshot,
            phase: "reconnecting",
            hello: null,
          });
          return null;
        }
        throw new Error("Assignment rejected");
      });
      try {
        void modal.track(pane.handleHeaderSessionAction({ kind: "new-group" }, row));
        await submitInputDialog("Keep this group");
        await vi.waitFor(() =>
          expect(document.body.querySelector("openclaw-modal-dialog [role=alert]")).not.toBeNull(),
        );
        expect((await waitForInputDialog()).value).toBe("Keep this group");
        expect(document.body.textContent).toContain(
          outcome === "failed" ? "Assignment rejected" : "Gateway connection replaced",
        );
      } finally {
        await modal.cleanup();
      }
    },
  );

  it("refuses archived-session restore without exact sessions.patch access", async () => {
    const { pane, state, patch } = createPatchPane();
    pane.context.gateway.snapshot.hello = hello("operator.read");

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(state.chatError).toBeTruthy();
    expect(state.lastError).toBe(state.chatError);
    expect(patch).not.toHaveBeenCalled();
  });

  it("restores the exact durable session observed by the composer", async () => {
    const { pane, state, patch } = createPatchPane({ ok: true });
    pane.context.gateway.snapshot.hello = hello();
    state.sessionsResult = sessionsResult(
      [
        {
          key: state.sessionKey,
          kind: "direct",
          sessionId: "session-a",
          archived: true,
          sharingRole: "owner",
        },
      ],
      0,
    );

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(patch).toHaveBeenCalledWith(
      state.sessionKey,
      { archived: false },
      { agentId: "main", expectedSessionId: "session-a" },
    );
  });

  it("keeps sharing hidden when legacy Gateways omit method metadata", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    const container = renderSharingHeader(pane, state);

    expect(container.querySelector(".chat-pane__sharing-menu")).toBeNull();
  });

  it("keeps visibility controls available without member-list support", async () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["session.visibility.set"] },
      policy: { allowedSessionVisibilities: ["shared", "read-only"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    const container = renderSharingHeader(pane, state, true);

    await waitForSolid(() =>
      expect(
        container.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled,
      ).toBe(false),
    );
    const menu = container.querySelector(".chat-pane__sharing-menu")!;
    await openNativeMenu(menu, "access");
    expect(container.querySelector(".chat-pane__sharing-permissions")).toBeNull();
    await waitForSolid(() =>
      expect(container.querySelector<HTMLButtonElement>('[data-value="access"]')?.disabled).toBe(
        false,
      ),
    );
    const access = container.querySelector<HTMLButtonElement>('[data-value="access"]');
    expect(access).not.toBeNull();
    access!.click();
    await waitForSolid(() =>
      expect(
        container.querySelector<HTMLButtonElement>('[data-value="visibility:read-only"]')?.disabled,
      ).toBe(false),
    );
  });
});
