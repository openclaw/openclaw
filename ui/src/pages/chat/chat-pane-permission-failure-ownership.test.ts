/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent, createSignal, merge } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import type { GatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { ChatPermissionPicker } from "./components/chat-permission-picker.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

function permissionPicker(state: ChatPageHost, selectedSession: GatewaySessionRow | undefined) {
  return renderChatPaneComposerControls({
    state,
    selectedSession,
    agentDefaultModel: undefined,
    modelAccess: { allowed: true, requiredScope: "operator.write" },
    effortAccess: { allowed: true, requiredScope: "operator.write" },
    contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
    permissionAccess: { allowed: true, requiredScope: "operator.write" },
    canSelectFull: true,
    onModelSetup: vi.fn(),
  }).permissionPicker;
}

function permissionSession(
  key: string,
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key,
    agentId: "main",
    kind: "direct",
    permissionMode: "workspace",
    updatedAt: 1,
    ...overrides,
  };
}

function sessionList(...sessions: GatewaySessionRow[]) {
  return { ...createSessionsListResult(), sessions };
}

function expectPicker(trigger: HTMLButtonElement, mode: string, disabled: boolean) {
  expect(trigger.getAttribute("aria-label")).toContain(
    t(`chat.permissionControls.modes.${mode}.label`),
  );
  expect(trigger.disabled).toBe(disabled);
}

function expectErrors(state: ChatPageHost, error: string | null) {
  expect(state).toMatchObject({ chatError: error, lastError: error });
}

function expectPermissionPatch(
  request: GatewayRequestMock,
  row: Pick<GatewaySessionRow, "key" | "sessionId">,
  exactIdentity = true,
) {
  expect(request).toHaveBeenCalledWith(
    "sessions.patch",
    expect.objectContaining({
      key: row.key,
      permissionMode: "full",
      ...(exactIdentity ? { expectedSessionId: row.sessionId } : {}),
    }),
  );
}

describe("chat permission failure ownership", () => {
  it.each([
    ["primary list", "full", "main", "immediate"],
    ["observed row with another agent selected", "guarded", "research", "immediate"],
    ["later scoped recovery", "guarded", "research", "affected"],
    ["later identical observed row", "workspace", "research", "identical"],
    ["unrelated foreground refresh", "guarded", "research", "unrelated"],
  ] as const)(
    "reconciles the permission picker after application fails (%s)",
    async (_source, persistedMode, foregroundAgent, recovery) => {
      const pending = createDeferred<Record<string, never>>();
      let permissionMode: GatewaySessionRow["permissionMode"] = "workspace";
      let recoveryUnavailable = false;
      const selectedSession: GatewaySessionRow = {
        key: "agent:main:remote-worker",
        kind: "direct",
        hasActiveRun: true,
        permissionMode,
        sessionId: "remote-worker-session",
        ...(recovery === "identical" ? { updatedAt: 1 } : {}),
      };
      const otherSession: GatewaySessionRow = { key: "agent:research:other", kind: "direct" };
      const host = makeChatHost({
        sessionKey: selectedSession.key,
        assistantAgentId: "main",
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": () => pending.promise,
          "sessions.list": (params: { agentId?: string }) => {
            if (params.agentId === "main" && recoveryUnavailable) {
              throw new Error("Permission read unavailable");
            }
            return sessionList(
              params.agentId === "main" ? { ...selectedSession, permissionMode } : otherSession,
            );
          },
        },
      });
      const state = host as unknown as ChatPageHost;
      const observation = host.sessions.observeRow(
        { key: selectedSession.key, agentId: "main" },
        (row) => {
          state.sessionsResult = sessionList(...(row ? [row] : []));
          state.sessionsResultAgentId = "main";
        },
      );
      const picker = () => permissionPicker(state, observation.row ?? undefined);
      let selection: Promise<unknown> = Promise.resolve();
      try {
        await host.sessions.refresh({ agentId: "main", force: true });
        const controls = picker();
        selection = Promise.resolve(controls.onSelect("full"));
        await vi.waitFor(() => expectPermissionPatch(host.request, selectedSession));
        const [currentPicker, setCurrentPicker] = createSignal(picker());
        const view = mountSolid(() => createComponent(ChatPermissionPicker, merge(currentPicker)), {
          container: document.createElement("div"),
        });
        const trigger = view.container.querySelector<HTMLButtonElement>(
          "[data-chat-permission-select]",
        )!;
        const draw = () => {
          setCurrentPicker(picker());
          flush();
        };
        expectPicker(trigger, "full", true);
        expect(trigger.getAttribute("aria-label")).not.toContain("Applying permissions");
        void controls.onSelect("guarded");
        const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
        expect(patches).toHaveLength(1);
        expect(patches[0]?.[1]).not.toHaveProperty("agentId");
        if (recovery === "identical") {
          expect(observation.captureReconcile()({ ...selectedSession })).toMatchObject({
            status: "current",
            row: { permissionMode: "workspace", updatedAt: 1 },
          });
        }
        state.assistantAgentId = foregroundAgent;
        await host.sessions.refresh({ agentId: foregroundAgent, force: true });
        const revision = host.sessions.canonicalListRevision;
        permissionMode = persistedMode;
        recoveryUnavailable = recovery !== "immediate";
        pending.reject(new Error("saved mode could not be applied to the active run"));
        await selection;
        expect(state.chatError).toContain("Failed to update permissions");
        if (recovery !== "immediate") {
          draw();
          expectPicker(trigger, "full", false);
          recoveryUnavailable = false;
          if (recovery === "affected") {
            await host.sessions.reconcileMutation("main");
          } else if (recovery === "identical") {
            expect(observation.captureReconcile()({ ...selectedSession })).toMatchObject({
              status: "current",
              row: { permissionMode: persistedMode, updatedAt: 1 },
            });
          } else {
            await host.sessions.refresh({ agentId: "research", force: true });
          }
        }
        expect(host.sessions.state.agentId).toBe(foregroundAgent);
        expect(host.sessions.state.result?.sessions.map((row) => row.key)).toEqual([
          foregroundAgent === "main" ? selectedSession.key : otherSession.key,
        ]);
        draw();
        expectPicker(trigger, recovery === "unrelated" ? "full" : persistedMode, false);
        expect(host.sessions.canonicalListRevision).toBe(
          revision + (foregroundAgent === "main" || recovery === "unrelated" ? 1 : 0),
        );
      } finally {
        pending.resolve({});
        await selection;
        observation.dispose();
        host.sessions.dispose();
      }
    },
  );

  it.each(["current", "before recovery", "during recovery", "newer selection"] as const)(
    "keeps permission errors with their captured incarnation (%s)",
    async (replacement) => {
      const original = permissionSession("agent:main:permission-incarnation", {
        sessionId: "permission-incarnation-a",
      });
      let current = original;
      const list = () => sessionList(current);
      const patchReply = createDeferred<unknown>();
      const patchIssued = createDeferred();
      const recoveryReply = createDeferred<ReturnType<typeof list>>();
      const recoveryIssued = createDeferred();
      let recoverySnapshot = list();
      let firstPatch = true;
      let holdRecovery = false;
      const host = makeChatHost({
        sessionKey: original.key,
        sessionsResult: list(),
        sessionsResultAgentId: "main",
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": (params: {
            permissionMode: GatewaySessionRow["permissionMode"] | null;
          }) => {
            if (firstPatch) {
              firstPatch = false;
              patchIssued.resolve();
              return patchReply.promise;
            }
            current = { ...current, permissionMode: params.permissionMode ?? undefined };
            return { ok: true, key: current.key, entry: { ...current } };
          },
          "sessions.list": (params: { agentId?: string }) => {
            if (params.agentId === "research") {
              return sessionList();
            }
            if (holdRecovery) {
              holdRecovery = false;
              recoverySnapshot = list();
              recoveryIssued.resolve();
              return recoveryReply.promise;
            }
            return list();
          },
        },
      });
      const state = host as unknown as ChatPageHost;
      const unsubscribe = host.sessions.subscribe((next) => {
        if (next.agentId === "main") {
          state.sessionsResult = next.result;
        }
      });
      const controls = () =>
        permissionPicker(
          state,
          state.sessionsResult?.sessions.find((row) => row.key === original.key),
        );
      const observation = host.sessions.observeRow(
        { key: original.key, agentId: "main" },
        () => {},
      );
      const successorError = "Successor's current error";
      const replace = async () => {
        current = {
          ...original,
          sessionId: "permission-incarnation-b",
          permissionMode: "read-only",
          updatedAt: 2,
        };
        await host.sessions.refresh({ agentId: "main", force: true });
        expect(state.sessionsResult?.sessions[0]?.sessionId).toBe(current.sessionId);
        state.chatError = state.lastError = successorError;
      };
      const operations: Promise<unknown>[] = [];
      try {
        await host.sessions.refresh({ agentId: "main", force: true });
        // A scoped recovery must not serialize with the other agent's foreground list.
        await host.sessions.refresh({ agentId: "research", force: true });
        expect(host.sessions.state.agentId).toBe("research");
        expect(state.sessionsResult?.sessions[0]?.sessionId).toBe(original.sessionId);
        const older = Promise.resolve(controls().onSelect("full"));
        operations.push(older);
        await patchIssued.promise;
        expectPermissionPatch(host.request, original);
        if (replacement === "before recovery") {
          await replace();
        }
        holdRecovery = true;
        patchReply.reject(new Error("Original permission application rejected"));
        await recoveryIssued.promise;
        if (replacement === "during recovery" || replacement === "newer selection") {
          await replace();
        }
        if (replacement === "newer selection") {
          holdRecovery = false;
          const newer = Promise.resolve(controls().onSelect("guarded"));
          operations.push(newer);
          await newer;
          expect(current.permissionMode).toBe("guarded");
          expect(state.chatError).toBeNull();
        }
        recoveryReply.resolve(recoverySnapshot);
        await older;
        if (replacement === "current") {
          expect(state.chatError).toContain("Original permission application rejected");
          expect(state.lastError).toBe(state.chatError);
        } else {
          const error = replacement === "newer selection" ? null : successorError;
          expectErrors(state, error);
        }
        expect(current.permissionMode).toBe(
          replacement === "current"
            ? "workspace"
            : replacement === "newer selection"
              ? "guarded"
              : "read-only",
        );
      } finally {
        holdRecovery = false;
        patchReply.resolve({ ok: true, key: current.key, entry: { ...current } });
        recoveryReply.resolve(recoverySnapshot);
        await Promise.allSettled(operations);
        unsubscribe();
        observation.dispose();
        host.sessions.dispose();
        host.client?.stop();
      }
    },
  );

  it("retires a permission error when scoped recovery discovers its successor", async () => {
    installTranscriptDomMocks();
    onTestFinished(resetTranscriptTestDom);
    const primary = permissionSession("agent:main:primary", {
      sessionId: "primary-session",
      permissionMode: undefined,
    });
    const original = permissionSession("agent:research:permission-recovery", {
      agentId: "research",
      sessionId: "permission-recovery-a",
    });
    const successor = { ...original, sessionId: "permission-recovery-b", updatedAt: 2 };
    const descriptorReply = createDeferred<{ session: GatewaySessionRow }>();
    let recovering = false;
    const { sessions, mount } = createMountedPanes([primary, original], "research", undefined, {
      "sessions.patch": () => {
        recovering = true;
        throw new Error("Original permission application rejected");
      },
      "sessions.list": (_method, raw) => {
        const params = asOptionalRecord(raw);
        return sessionList(params?.agentId === "research" ? successor : primary);
      },
      "sessions.describe": () => (recovering ? descriptorReply.promise : { session: original }),
    });
    let selection: Promise<unknown> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(original.key);
      await refreshPane(pane);
      const state = pane.state;
      expect(selectedChatSessionRow(state)).toMatchObject(original);
      selection = Promise.resolve(
        permissionPicker(state, selectedChatSessionRow(state)).onSelect("full"),
      );
      await selection;
      expect(sessions.state.agentId).toBe("main");
      expect(selectedChatSessionRow(state)?.sessionId).not.toBe(original.sessionId);
      expectErrors(state, null);
    } finally {
      descriptorReply.resolve({ session: successor });
      await selection;
      await vi.dynamicImportSettled();
    }
  });

  it.each([
    "configured main alias",
    "retired identity-less row",
    "identity-less row",
    "empty draft",
  ] as const)("keeps permission ownership for %s", async (scenario) => {
    const alias = scenario === "configured main alias";
    const row = permissionSession(alias ? "agent:main:home" : "agent:main:permission-draft", {
      sessionId: alias ? "configured-main-session" : undefined,
      updatedAt: undefined,
    });
    let rows = scenario === "empty draft" ? [] : [row];
    const list = () => sessionList(...rows);
    const host = makeChatHost({
      sessionKey: alias ? "main" : row.key,
      agentsList: { defaultId: "main", mainKey: alias ? "home" : "main", agents: [{ id: "main" }] },
      sessionsResult: list(),
      sessionsResultAgentId: "main",
      chatModelSwitchPromises: {},
      requestHandlers: {
        "sessions.patch": () => {
          if (scenario === "retired identity-less row") {
            rows = [];
          }
          throw new Error("Permission update rejected");
        },
        "sessions.list": list,
      },
    });
    const state = host as unknown as ChatPageHost;
    const unsubscribe = host.sessions.subscribe((next) => {
      state.sessionsResult = next.result;
      state.sessionsResultAgentId = next.agentId;
    });
    try {
      await host.sessions.refresh({ agentId: "main", force: true });
      await permissionPicker(state, selectedChatSessionRow(state)).onSelect("full");
      expectPermissionPatch(host.request, { key: state.sessionKey }, false);
      if (scenario === "retired identity-less row") {
        expect(selectedChatSessionRow(state)).toBeUndefined();
        expectErrors(state, null);
      } else {
        expect(state.chatError).toContain("Permission update rejected");
        expect(state.lastError).toBe(state.chatError);
      }
    } finally {
      unsubscribe();
      host.sessions.dispose();
      host.client?.stop();
    }
  });
});
