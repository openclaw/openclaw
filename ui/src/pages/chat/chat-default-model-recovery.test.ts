/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createChatDefaultModelRecovery } from "./chat-default-model-recovery.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatComposerNotices } from "./chat-view-notices.tsx";

function fixture() {
  const result = createSessionsListResult({
    model: "selected",
    modelProvider: "fixture",
    modelOverrideSource: "user",
    defaultsModel: "default",
    defaultsProvider: "fixture",
  });
  result.sessions[0]!.sessionId = "main";
  result.sessions[0]!.updatedAt = 1;
  const host = makeChatHost({
    sessionKey: "main",
    sessionsResult: result,
    chatModelSwitchPromises: {},
    chatModelCatalog: [
      { id: "selected", provider: "fixture", name: "Selected", available: true },
      { id: "default", provider: "fixture", name: "Default", available: true },
    ],
    requestHandlers: {
      "sessions.patch": { ok: true, key: "main", path: "", entry: { sessionId: "main" } },
      "sessions.list": result,
    },
  });
  // The production owner reads only model-selection and run/catalog facts from the pane.
  const pane = Object.assign(host, {
    chatRunError: { summary: "Provider request failed", runId: "failed-run" },
    chatModelCatalogInitialized: true,
    chatModelCatalogRetired: false,
  }) as unknown as ChatPageHost;
  onTestFinished(() => host.sessions.dispose());
  let allowed = true;
  let agentDefault: string | undefined;
  return {
    host,
    pane,
    row: result.sessions[0]!,
    create: () =>
      createChatDefaultModelRecovery(pane, {
        readAgentDefaultModel: () => agentDefault,
        canDispatch: () => allowed,
      }),
    deny: () => {
      allowed = false;
    },
    changeDefault: () => {
      agentDefault = "fixture/selected";
    },
  };
}

it.each([undefined, "fixture-profile"])(
  "switches without replay or resetting runtime/auth pins (%s)",
  async (profile) => {
    const { host, pane, row, create } = fixture();
    if (profile) {
      row.model = `selected@${profile}`;
    }
    const savedTools = [{ role: "toolResult", toolCallId: "completed", content: "Saved output" }];
    host.chatMessages = savedTools;
    row.agentRuntime = { id: "fixture-runtime", source: "session-key" };
    host.chatModelCatalog[1]!.runtimeChoices = [
      {
        agentRuntime: { id: "fixture-runtime", source: "model" },
        available: true,
      },
    ];
    const action = create();
    expect(action?.modelLabel).toBe("Default");
    const { container } = mountSolid(() =>
      renderChatComposerNotices({
        messages: [],
        connected: true,
        runError: pane.chatRunError,
        defaultModelRecovery: () => create(),
      }),
    );
    await waitForSolid(() =>
      expect(container.querySelector("[data-chat-default-model-recovery]")).not.toBeNull(),
    );
    const button = container.querySelector<HTMLButtonElement>(
      "[data-chat-default-model-recovery]",
    )!;
    expect(container.textContent).toContain("Does not retry the failed message.");
    button.click();
    await waitForSolid(() => expect(requestCalls(host.request, "sessions.patch")).toHaveLength(1));
    expect(requestCalls(host.request, "sessions.patch")).toEqual([
      [
        "sessions.patch",
        {
          key: "main",
          model: "fixture/default" + (profile ? `@${profile}` : ""),
          expectedSessionId: "main",
        },
      ],
    ]);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatMessages).toBe(savedTools);
  },
);

it.each(["locked", "busy", "unavailable", "other-provider", "stale-catalog", "runtime"] as const)(
  "does not offer a switch for %s",
  (reason) => {
    const { pane, row, create } = fixture();
    if (reason === "locked") {
      row.modelSelectionLocked = true;
    }
    if (reason === "busy") {
      pane.chatRunId = "active";
    }
    if (reason === "unavailable") {
      pane.chatModelCatalog[1]!.available = false;
    }
    if (reason === "other-provider") {
      pane.chatModelCatalog[1]!.provider = "other";
    }
    if (reason === "stale-catalog") {
      pane.chatModelCatalogRetired = true;
    }
    if (reason === "runtime") {
      row.agentRuntime = { id: "unsupported", source: "session-key" };
    }
    expect(create()).toBeUndefined();
  },
);

it.each([
  "failure",
  "selection",
  "session",
  "permission",
  "default",
  "lock",
  "run",
  "connection",
  "runtime",
  "agent-inventory",
] as const)("rejects a retained action after changing %s", async (change) => {
  const { host, pane, row, create, deny, changeDefault } = fixture();
  const action = create();
  expect(action).toBeDefined();
  if (change === "failure") {
    pane.chatRunError = { summary: "New failure", runId: "new" };
  }
  if (change === "selection") {
    row.model = "different";
  }
  if (change === "session") {
    row.sessionId = "replacement";
  }
  if (change === "permission") {
    deny();
  }
  if (change === "default") {
    changeDefault();
  }
  if (change === "lock") {
    row.modelSelectionLocked = true;
  }
  if (change === "run") {
    pane.chatRunId = "new-run";
  }
  if (change === "connection") {
    pane.connectionEpoch += 1;
  }
  if (change === "runtime") {
    row.agentRuntime = { id: "other", source: "session-key" };
  }
  if (change === "agent-inventory") {
    pane.agentsList = null;
  }
  expect(await action?.switchModel()).toBe(false);
  expect(requestCalls(host.request, "sessions.patch")).toHaveLength(0);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
});

it.each(["lock", "failure"] as const)(
  "rechecks %s after model-switch confirmation",
  async (change) => {
    vi.stubGlobal("localStorage", createStorageMock());
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const dialogs = createModalDialogTestFixture();
    onTestFinished(() => dialogs.cleanup());
    const { host, pane, row, create } = fixture();
    host.chatMessages = [{ role: "user", content: "Original request" }];
    const action = create();
    expect(action).toBeDefined();
    const switching = dialogs.track(action!.switchModel());
    const actions = await waitForConfirmDialogActions();
    if (change === "lock") {
      row.modelSelectionLocked = true;
    }
    if (change === "failure") {
      pane.chatRunError = { summary: "A newer failure", runId: "new" };
    }
    answerConfirmDialog(actions, "confirm");
    await vi.dynamicImportSettled();
    expect(requestCalls(host.request, "sessions.patch")).toHaveLength(0);
    // An invalid confirmation stays open so the user can cancel or choose another model.
    answerConfirmDialog(actions, "cancel");
    await expect(switching).resolves.toBe(false);
    expect(requestCalls(host.request, "sessions.patch")).toHaveLength(0);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  },
);
