/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import * as modelControls from "./components/chat-model-controls.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

type Setting = "thinking" | "speed" | "context";
const settings: Setting[] = ["thinking", "speed", "context"];
const model: ModelCatalogEntry = {
  id: "fixture-model",
  name: "Fixture model",
  provider: "fixture",
  reasoning: true,
  supportsFastMode: true,
  thinkingLevels: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  thinkingDefault: "low",
};

it.each(
  (["absent", "placeholder"] as const).flatMap((initialState) =>
    settings.flatMap((setting) =>
      (initialState === "placeholder" || setting === "thinking" ? [false, true] : [false]).map(
        (returnToInitial) => ({ initialState, setting, returnToInitial }),
      ),
    ),
  ),
)(
  "renders admitted unmaterialized $setting intent ($initialState, return=$returnToInitial)",
  async ({ initialState, setting, returnToInitial }) => {
    const key = "agent:main:main";
    const initial: GatewaySessionRow = {
      key,
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
      model: model.id,
      modelProvider: model.provider,
      thinkingLevel: "low",
      thinkingLevels: model.thinkingLevels,
      thinkingDefault: "low",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
      contextWindowDefault: "64k",
      contextWindows: [
        { id: "64k", label: "64K", contextWindow: 64_000 },
        { id: "128k", label: "128K", contextWindow: 128_000 },
      ],
    };
    const rows = initialState === "placeholder" ? [initial] : [];
    const reply = createDeferred<unknown>();
    const latestReply = createDeferred<unknown>();
    const latestDispatched = createDeferred();
    const materialized: GatewaySessionRow = {
      ...initial,
      sessionId: "settings-return-session",
      updatedAt: 2,
      ...(setting === "thinking"
        ? { thinkingLevel: "high" }
        : setting === "speed"
          ? { fastMode: true, effectiveFastMode: true }
          : { contextWindow: "128k" }),
    };
    const committed: GatewaySessionRow = {
      ...initial,
      sessionId: materialized.sessionId,
      updatedAt: 3,
      ...(initialState === "absent" ? { thinkingLevel: undefined } : {}),
    };
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      if (patch.mock.calls.length === 1) {
        return reply.promise;
      }
      expect(patch.mock.calls.length).toBe(2);
      expect(raw).toMatchObject({ key, expectedSessionId: materialized.sessionId });
      latestDispatched.resolve();
      return latestReply.promise.then((result) => {
        rows.splice(0, rows.length, committed);
        return result;
      });
    });
    const { sessions, mount, context } = createMountedPanes(rows, "main", undefined, {
      "sessions.list": () => ({
        ...sessionsResult(rows, 1),
        defaults: {
          model: model.id,
          modelProvider: model.provider,
          contextTokens: 64_000,
          thinkingLevels: model.thinkingLevels,
          thinkingDefault: "low",
          contextWindow: "64k",
          contextWindowDefault: "64k",
          contextWindows: initial.contextWindows,
        },
      }),
      "sessions.patch": patch,
    });
    const rendered = vi.spyOn(modelControls, "renderChatModelControls");
    let operation: Promise<unknown> | undefined;
    let latestOperation: Promise<unknown> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(key);
      await refreshPane(pane);
      pane.state.chatModelCatalog = [model];
      const container = document.createElement("div");
      const draw = () => {
        const access = readChatPaneMutationAccess(context.gateway.snapshot, key);
        expect(access.effort.allowed).toBe(true);
        expect(access.contextWindow.allowed).toBe(true);
        const controls = renderChatPaneComposerControls({
          state: pane.state,
          selectedSession: selectedChatSessionRow(pane.state),
          agentDefaultModel: undefined,
          modelAccess: access.model,
          effortAccess: access.effort,
          contextWindowAccess: access.contextWindow,
          permissionAccess: access.permission,
          canSelectFull: false,
          onModelSetup: vi.fn(),
        });
        render(controls.composerControls, container);
        const props = rendered.mock.calls.at(-1)?.[0];
        if (!props) {
          throw new Error("Expected mounted composer control props");
        }
        return props;
      };
      const props = draw();
      const effort = container.querySelector<HTMLElement>("[data-chat-thinking-select]");
      const initialThinking = initialState === "placeholder" ? "low" : "";
      expect(effort?.dataset.chatThinkingValue).toBe(initialThinking);
      expect(effort?.getAttribute("aria-disabled")).toBe("false");
      expect(effort?.dataset.chatThinkingDisabled).toBe("false");
      if (setting === "context") {
        const control = container.querySelector<HTMLButtonElement>(
          "[data-chat-context-window-toggle]",
        );
        expect(control?.disabled).toBe(false);
        operation = Promise.resolve(props.onContextWindowSelect?.("128k", key));
      } else if (setting === "speed") {
        operation = Promise.resolve(props.onFastModeSelect?.("on", key));
      } else {
        operation = Promise.resolve(props.onThinkingSelect?.("high", key));
      }
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).not.toHaveProperty("expectedSessionId");
      // The RPC is still held; a real render must keep the admitted selection.
      const pendingProps = draw();
      const latest = container.querySelector<HTMLElement>("[data-chat-thinking-select]");
      if (setting === "thinking") {
        expect.soft(latest?.dataset.chatThinkingValue).toBe("high");
      } else if (setting === "speed") {
        expect.soft(latest?.dataset.chatFastMode).toBe("true");
      } else {
        expect
          .soft(
            container
              .querySelector("[data-chat-context-window-toggle]")
              ?.getAttribute("aria-checked"),
          )
          .toBe("true");
      }
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      expect(sessions.state.result?.sessions).toHaveLength(initialState === "placeholder" ? 1 : 0);
      if (returnToInitial) {
        latestOperation = Promise.resolve(
          setting === "thinking"
            ? pendingProps.onThinkingSelect?.(initialThinking, key)
            : setting === "speed"
              ? pendingProps.onFastModeSelect?.("off", key)
              : pendingProps.onContextWindowSelect?.("64k", key),
        );
        expect(patch).toHaveBeenCalledOnce();
        draw();
        const returnedEffort = container.querySelector<HTMLElement>("[data-chat-thinking-select]");
        expect.soft(returnedEffort?.dataset.chatThinkingValue).toBe(initialThinking);
        expect.soft(returnedEffort?.dataset.chatFastMode).toBe("false");
        expect
          .soft(
            container
              .querySelector("[data-chat-context-window-toggle]")
              ?.getAttribute("aria-checked"),
          )
          .toBe("false");
        // The first write creates the row; its ACK alone authorizes the queued target.
        rows.splice(0, rows.length, materialized);
        reply.resolve({ ok: true, key, path: "", entry: materialized });
        await expect(operation).resolves.toBe(true);
        await Promise.race([latestDispatched.promise, latestOperation]);
        expect.soft(patch).toHaveBeenCalledTimes(2);
        expect.soft(patch.mock.calls[1]?.[1]).toEqual({
          key,
          expectedSessionId: materialized.sessionId,
          ...(setting === "thinking"
            ? { thinkingLevel: initialThinking || null }
            : setting === "speed"
              ? { fastMode: false }
              : { contextWindow: "64k" }),
        });
        latestReply.resolve({ ok: true, key, path: "", entry: committed });
        await expect(latestOperation).resolves.toBe(true);
        expect(selectedChatSessionRow(pane.state)).toMatchObject(committed);
      } else {
        reply.reject(new Error("Synthetic unmaterialized selection rejection"));
        await expect(operation).resolves.toBe(false);
      }
      draw();
      expect(
        container.querySelector<HTMLElement>("[data-chat-thinking-select]")?.dataset
          .chatThinkingValue,
      ).toBe(initialThinking);
      expect(
        container.querySelector<HTMLElement>("[data-chat-thinking-select]")?.dataset.chatFastMode,
      ).toBe("false");
      expect(
        container.querySelector("[data-chat-context-window-toggle]")?.getAttribute("aria-checked"),
      ).toBe("false");
      if (returnToInitial) {
        expect(pane.state.chatError).toBeNull();
      } else {
        expect(pane.state.chatError).toContain("Synthetic unmaterialized selection rejection");
      }
    } finally {
      reply.resolve({ ok: true, key, path: "", entry: initial });
      latestReply.resolve({ ok: true, key, path: "", entry: committed });
      await Promise.allSettled([operation, latestOperation]);
      await vi.dynamicImportSettled();
    }
  },
);
