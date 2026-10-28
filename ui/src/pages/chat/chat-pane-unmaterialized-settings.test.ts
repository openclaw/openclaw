/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { withSessionMutationOperations } from "../../lib/sessions/session-mutation-operations.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderPaneModelControl } from "./chat-pane-model-control.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { refreshChatModelCatalogOnDemand } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import * as modelControls from "./components/chat-model-controls.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

const settings = {
  thinking: ["thinkingLevel", { thinkingLevel: "high" }, { thinking: "high" }],
  speed: ["fastMode", { fastMode: true, effectiveFastMode: true }, { fast: "true" }],
  context: ["contextWindow", { contextWindow: "128k" }, { context: "true" }],
} as const;
const model: ModelCatalogEntry = {
  id: "fixture-model",
  name: "Fixture model",
  provider: "fixture",
  reasoning: true,
  supportsFastMode: true,
  thinkingLevels: ["low", "high"].map((id) => ({ id, label: id === "low" ? "Low" : "High" })),
  thinkingDefault: "low",
};
const defaults = {
  model: model.id,
  modelProvider: model.provider,
  thinkingLevels: model.thinkingLevels,
  thinkingDefault: "low",
  contextWindow: "64k",
  contextWindowDefault: "64k",
  contextWindows: [
    { id: "64k", label: "64K", contextWindow: 64_000 },
    { id: "128k", label: "128K", contextWindow: 128_000 },
  ],
};

it.each([
  ["absent", "thinking", false],
  ["absent", "thinking", true],
  ["absent", "speed", false],
  ["absent", "context", false],
  ["placeholder", "thinking", true],
  ["placeholder", "speed", true],
  ["placeholder", "context", true],
] as const)("retains %s %s intent (return=%s)", async (initialState, setting, returnToInitial) => {
  const [field, change, pending] = settings[setting];
  const key = "agent:main:main";
  const initial: GatewaySessionRow = {
    ...defaults,
    key,
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
    thinkingLevel: "low",
    fastMode: false,
    effectiveFastMode: false,
  };
  const rows = initialState === "placeholder" ? [initial] : [];
  const reply = createDeferred<unknown>();
  const latestReply = createDeferred<unknown>();
  const latestDispatched = createDeferred();
  const sessionId = "settings-return-session";
  const materialized: GatewaySessionRow = { ...initial, sessionId, updatedAt: 2, ...change };
  const thinkingLevel = initialState === "absent" ? undefined : initial.thinkingLevel;
  const committed: GatewaySessionRow = { ...initial, sessionId, updatedAt: 3, thinkingLevel };
  const ack = (entry: GatewaySessionRow) => ({ ok: true, key, path: "", entry });
  const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
    if (patch.mock.calls.length === 1) {
      return reply.promise;
    }
    expect(patch.mock.calls.length).toBe(2);
    expect(raw).toMatchObject({ key, expectedSessionId: sessionId });
    latestDispatched.resolve();
    return latestReply.promise.then((result) => {
      rows.splice(0, rows.length, committed);
      return result;
    });
  });
  const { sessions, mount, context } = createMountedPanes(rows, "main", undefined, {
    "models.list": () => ({ models: [model] }),
    "sessions.list": () => ({
      ...sessionsResult(rows, 1),
      defaults: { ...defaults, contextTokens: 64_000 },
    }),
    "sessions.patch": patch,
  });
  const rendered = vi.spyOn(modelControls, "ChatModelControls");
  let operation: Promise<unknown> | undefined;
  let latestOperation: Promise<unknown> | undefined;
  try {
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(key);
    await refreshPane(pane);
    await refreshChatModelCatalogOnDemand(pane.state);
    const container = document.createElement("div");
    const controlValues = () => {
      const effort = container.querySelector<HTMLElement>("[data-chat-thinking-select]");
      return {
        thinking: effort?.dataset.chatThinkingValue,
        fast: effort?.dataset.chatFastMode,
        context: container
          .querySelector("[data-chat-context-window-toggle]")
          ?.getAttribute("aria-checked"),
      };
    };
    const draw = () => {
      const access = readChatPaneMutationAccess(context.gateway.snapshot, key);
      expect([access.effort.allowed, access.contextWindow.allowed]).toEqual([true, true]);
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
      renderPaneModelControl(controls.composerControls, container, true);
      return expectDefined(rendered.mock.calls.at(-1)?.[0], "mounted composer control props");
    };
    const props = draw();
    await waitForSolid(() =>
      expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
    );
    const effort = container.querySelector<HTMLElement>("[data-chat-thinking-select]");
    const initialThinking = initialState === "placeholder" ? "low" : "";
    const initialValues = { thinking: initialThinking, fast: "false", context: "false" };
    expect(effort?.dataset).toMatchObject({
      chatThinkingValue: initialThinking,
      chatThinkingDisabled: "false",
    });
    expect(effort?.getAttribute("aria-disabled")).toBe("false");
    const select = (controls: ReturnType<typeof draw>, reset = false) =>
      Promise.resolve(
        setting === "thinking"
          ? controls.onThinkingSelect?.(reset ? initialThinking : "high", key)
          : setting === "speed"
            ? controls.onFastModeSelect?.(reset ? "off" : "on", key)
            : controls.onContextWindowSelect?.(reset ? "64k" : "128k", key),
      );
    if (setting === "context") {
      expect(
        container.querySelector<HTMLButtonElement>("[data-chat-context-window-toggle]")?.disabled,
      ).toBe(false);
    }
    operation = select(props);
    // The RPC is still held; a real render must keep the admitted selection.
    const pendingProps = draw();
    expect.soft(controlValues()).toMatchObject(pending);
    expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
    expect(sessions.state.result?.sessions).toHaveLength(initialState === "placeholder" ? 1 : 0);
    await withSessionMutationOperations(() => undefined);
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0]?.[1]).not.toHaveProperty("expectedSessionId");
    if (returnToInitial) {
      latestOperation = select(pendingProps, true);
      expect(patch).toHaveBeenCalledOnce();
      draw();
      expect.soft(controlValues()).toEqual(initialValues);
      // The first write creates the row; its ACK alone authorizes the queued target.
      rows.splice(0, rows.length, materialized);
      reply.resolve(ack(materialized));
      await expect(operation).resolves.toBe(true);
      await Promise.race([latestDispatched.promise, latestOperation]);
      expect.soft(patch).toHaveBeenCalledTimes(2);
      expect.soft(patch.mock.calls[1]?.[1]).toEqual({
        key,
        expectedSessionId: sessionId,
        [field]:
          setting === "thinking" ? initialThinking || null : setting === "speed" ? false : "64k",
      });
      latestReply.resolve(ack(committed));
      await expect(latestOperation).resolves.toBe(true);
      expect(selectedChatSessionRow(pane.state)).toEqual(committed);
    } else {
      reply.reject(new Error("Synthetic unmaterialized selection rejection"));
      await expect(operation).resolves.toBe(false);
    }
    draw();
    expect(controlValues()).toEqual(initialValues);
    expect(pane.state.chatError).toEqual(
      returnToInitial
        ? null
        : expect.stringContaining("Synthetic unmaterialized selection rejection"),
    );
  } finally {
    reply.resolve(ack(initial));
    latestReply.resolve(ack(committed));
    await Promise.allSettled([operation, latestOperation]);
  }
});
