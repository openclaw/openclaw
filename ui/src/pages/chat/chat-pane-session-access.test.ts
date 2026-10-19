/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createModalDialogTestFixture,
  submitInputDialog,
  waitForInputDialog,
} from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";

async function createHeaderDraftPane(row: GatewaySessionRow) {
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({
      request: async (method) => {
        switch (method) {
          case "agents.list":
            return {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "main" }],
            };
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
  it("refuses ordinary session creation for read-only operators", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.create"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(pane.createSession()).resolves.toBe(false);

    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.lastError).toContain("operator.sessions.write");
    expect(state.chatError).toBe(state.lastError);
  });

  it("requires operator.admin when session creation inherits an incognito parent", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:main:dashboard:incognito-current";
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.create"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(pane.createSession()).resolves.toBe(false);

    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.lastError).toContain("operator.admin");
    expect(state.chatError).toBe(state.lastError);
  });

  it("refuses header rename when sessions.patch is unavailable or lacks write scope", () => {
    for (const hello of [
      {
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["sessions.create"] },
      },
      {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["sessions.patch"] },
      },
    ]) {
      const patch = vi.fn(async () => ({}));
      const sessions = { patch } as unknown as SessionCapability;
      const { pane, state } = createTestChatPane({
        client: {} as GatewayBrowserClient,
        sessions,
      });
      pane.context.gateway.snapshot.hello =
        hello as ApplicationContext["gateway"]["snapshot"]["hello"];
      const session = {
        key: "agent:main:current",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;

      pane.beginHeaderRename(session);

      expect(Boolean(pane.headerPresentation.renameSession)).toBe(false);
      expect(state.chatError).toBeTruthy();
      expect(patch).not.toHaveBeenCalled();
    }
  });

  it("rechecks header rename access before committing", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerPresentation.renameValue = "Blocked rename";
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.commitHeaderRename();

    expect(state.chatError).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("cancels header rename when the Gateway source changes for the same session", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.context.gateway.snapshot.hello = hello;
    state.hello = hello;
    const session = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerPresentation.renameValue = "Replacement Gateway title";
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient,
      phase: "stopped",
      hello: null,
      sessionKey: state.sessionKey,
    });
    pane.commitHeaderRename();

    expect(Boolean(pane.headerPresentation.renameSession)).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it("retains inline rename text through a blip without submitting offline", async () => {
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
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
      const row: GatewaySessionRow = {
        key: "agent:main:current",
        sessionId: "current-session",
        kind: "direct",
        sharingRole: "owner",
      };
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
      } finally {
        await modal.cleanup();
      }
    },
  );

  it.each(["failed", "stale"] as const)(
    "keeps the header group draft after a %s assignment",
    async (outcome) => {
      const modal = createModalDialogTestFixture();
      const row: GatewaySessionRow = {
        key: "agent:main:current",
        sessionId: "current-session",
        kind: "direct",
      };
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
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(state.chatError).toBeTruthy();
    expect(state.lastError).toBe(state.chatError);
    expect(patch).not.toHaveBeenCalled();
  });

  it("restores the exact durable session observed by the composer", async () => {
    const patch = vi.fn(async () => ({ ok: true }));
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
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
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      sharingRole: "owner",
      visibility: "shared",
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");

    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );

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
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      sharingRole: "owner",
      visibility: "shared",
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => container.remove());

    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );

    await waitForSolid(() =>
      expect(
        container.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled,
      ).toBe(false),
    );
    container.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.click();
    await waitForSolid(() =>
      expect(container.querySelector(".chat-pane__sharing-panel")?.matches(":popover-open")).toBe(
        true,
      ),
    );
    expect(container.querySelector('[data-value="visibility:read-only"]')).not.toBeNull();
    expect(container.textContent).not.toContain("People");
  });
});
