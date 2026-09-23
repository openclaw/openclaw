/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

describe("chat permission failure ownership", () => {
  it.each([
    {
      source: "primary list",
      persistedMode: "full",
      foregroundAgent: "main",
      recovery: "immediate",
    },
    {
      source: "observed row with another agent selected",
      persistedMode: "guarded",
      foregroundAgent: "research",
      recovery: "immediate",
    },
    {
      source: "later scoped recovery",
      persistedMode: "guarded",
      foregroundAgent: "research",
      recovery: "affected",
    },
    {
      source: "later identical observed row",
      persistedMode: "workspace",
      foregroundAgent: "research",
      recovery: "identical",
    },
    {
      source: "unrelated foreground refresh",
      persistedMode: "guarded",
      foregroundAgent: "research",
      recovery: "unrelated",
    },
  ] as const)(
    "reconciles the permission picker after application fails ($source)",
    async ({ persistedMode, foregroundAgent, recovery }) => {
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
            return {
              ...createSessionsListResult(),
              sessions:
                params.agentId === "main"
                  ? [{ ...selectedSession, permissionMode }]
                  : [otherSession],
            };
          },
        },
      });
      const state = host as unknown as ChatPageHost;
      const observation = host.sessions.observeRow(
        { key: selectedSession.key, agentId: "main" },
        (row) => {
          state.sessionsResult = { ...createSessionsListResult(), sessions: row ? [row] : [] };
          state.sessionsResultAgentId = "main";
        },
      );
      const controlParams = {
        state,
        get selectedSession() {
          return observation.row ?? undefined;
        },
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" } as const,
        effortAccess: { allowed: true, requiredScope: "operator.write" } as const,
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
        permissionAccess: { allowed: true, requiredScope: "operator.write" } as const,
        canSelectFull: true,
        onModelSetup: vi.fn(),
      };
      let selection: Promise<unknown> = Promise.resolve();
      try {
        await host.sessions.refresh({ agentId: "main", force: true });
        const controls = renderChatPaneComposerControls(controlParams);
        selection = Promise.resolve(controls.permissionPicker.onSelect("full"));
        await vi.waitFor(() =>
          expect(host.request).toHaveBeenCalledWith(
            "sessions.patch",
            expect.objectContaining({
              key: selectedSession.key,
              permissionMode: "full",
              expectedSessionId: selectedSession.sessionId,
            }),
          ),
        );
        const container = document.createElement("div");
        const draw = () =>
          render(
            renderChatPermissionPicker(
              renderChatPaneComposerControls(controlParams).permissionPicker,
            ),
            container,
          );
        draw();
        const trigger = container.querySelector<HTMLButtonElement>(
          "[data-chat-permission-select]",
        )!;
        expect(trigger.textContent).toContain(t("chat.permissionControls.modes.full.label"));
        expect(trigger.textContent).not.toContain("Applying permissions");
        expect(trigger.disabled).toBe(true);
        void controls.permissionPicker.onSelect("guarded");
        expect(
          host.request.mock.calls.filter(([method]) => method === "sessions.patch"),
        ).toHaveLength(1);
        expect(
          host.request.mock.calls.find(([method]) => method === "sessions.patch")?.[1],
        ).not.toHaveProperty("agentId");
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
          expect(trigger.textContent).toContain(t("chat.permissionControls.modes.full.label"));
          expect(trigger.disabled).toBe(false);
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
        expect(trigger.textContent).toContain(
          t(
            `chat.permissionControls.modes.${recovery === "unrelated" ? "full" : persistedMode}.label`,
          ),
        );
        expect(trigger.disabled).toBe(false);
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
      const original: GatewaySessionRow = {
        key: "agent:main:permission-incarnation",
        agentId: "main",
        kind: "direct",
        sessionId: "permission-incarnation-a",
        permissionMode: "workspace",
        updatedAt: 1,
      };
      let current = original;
      const list = () => ({ ...createSessionsListResult(), sessions: [current] });
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
              return { ...createSessionsListResult(), sessions: [] };
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
      const observation = host.sessions.observeRow(
        { key: original.key, agentId: "main" },
        () => {},
      );
      const controls = () =>
        renderChatPaneComposerControls({
          state,
          selectedSession: state.sessionsResult?.sessions.find((row) => row.key === original.key),
          agentDefaultModel: undefined,
          modelAccess: { allowed: true, requiredScope: "operator.write" },
          effortAccess: { allowed: true, requiredScope: "operator.write" },
          contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
          permissionAccess: { allowed: true, requiredScope: "operator.write" },
          canSelectFull: true,
          onModelSetup: vi.fn(),
        });
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
        // A pane can retain main while the shared roster shows another agent.
        // Its mutation recovery uses the scoped reader, so a later foreground
        // list can establish B without violating primary-read serialization.
        await host.sessions.refresh({ agentId: "research", force: true });
        expect(host.sessions.state.agentId).toBe("research");
        expect(state.sessionsResult?.sessions[0]?.sessionId).toBe(original.sessionId);
        const older = Promise.resolve(controls().permissionPicker.onSelect("full"));
        operations.push(older);
        await patchIssued.promise;
        expect(host.request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({
            key: original.key,
            permissionMode: "full",
            expectedSessionId: original.sessionId,
          }),
        );
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
          const newer = Promise.resolve(controls().permissionPicker.onSelect("guarded"));
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
          expect(state.chatError).toBe(error);
          expect(state.lastError).toBe(error);
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
    const primary: GatewaySessionRow = {
      key: "agent:main:primary",
      agentId: "main",
      kind: "direct",
      sessionId: "primary-session",
      updatedAt: 1,
    };
    const original: GatewaySessionRow = {
      key: "agent:research:permission-recovery",
      agentId: "research",
      kind: "direct",
      sessionId: "permission-recovery-a",
      permissionMode: "workspace",
      updatedAt: 1,
    };
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
        return {
          ...createSessionsListResult(),
          sessions: params?.agentId === "research" ? [successor] : [primary],
        };
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
        renderChatPaneComposerControls({
          state,
          selectedSession: selectedChatSessionRow(state),
          agentDefaultModel: undefined,
          modelAccess: { allowed: true, requiredScope: "operator.write" },
          effortAccess: { allowed: true, requiredScope: "operator.write" },
          contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
          permissionAccess: { allowed: true, requiredScope: "operator.write" },
          canSelectFull: true,
          onModelSetup: vi.fn(),
        }).permissionPicker.onSelect("full"),
      );
      await selection;
      expect(sessions.state.agentId).toBe("main");
      expect(selectedChatSessionRow(state)?.sessionId).not.toBe(original.sessionId);
      expect(state.chatError).toBeNull();
      expect(state.lastError).toBeNull();
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
    const row: GatewaySessionRow = {
      key: alias ? "agent:main:home" : "agent:main:permission-draft",
      agentId: "main",
      kind: "direct",
      sessionId: alias ? "configured-main-session" : undefined,
      permissionMode: "workspace",
    };
    let rows = scenario === "empty draft" ? [] : [row];
    const list = () => ({ ...createSessionsListResult(), sessions: rows });
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
      await renderChatPaneComposerControls({
        state,
        selectedSession: selectedChatSessionRow(state),
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" },
        effortAccess: { allowed: true, requiredScope: "operator.write" },
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
        permissionAccess: { allowed: true, requiredScope: "operator.write" },
        canSelectFull: true,
        onModelSetup: vi.fn(),
      }).permissionPicker.onSelect("full");
      expect(host.request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({ key: state.sessionKey, permissionMode: "full" }),
      );
      if (scenario === "retired identity-less row") {
        expect(selectedChatSessionRow(state)).toBeUndefined();
        expect(state.chatError).toBeNull();
        expect(state.lastError).toBeNull();
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
