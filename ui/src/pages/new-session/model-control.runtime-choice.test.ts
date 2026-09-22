/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { loadNewSessionPreference, patchNewSessionPreference } from "./preferences.ts";

const agent: GatewayAgentRow = { id: "main", model: { primary: "openai/gpt-5.6-sol" } };
const models: ModelCatalogEntry[] = [
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    name: "GPT-5.6 Sol",
    available: true,
    contextWindow: 1_000_000,
    agentRuntime: {
      id: "openclaw",
      source: "model",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
    },
    thinkingLevels: [{ id: "medium", label: "Medium" }],
    thinkingDefault: "medium",
    supportsTools: true,
    runtimeChoices: [
      {
        agentRuntime: {
          id: "codex",
          source: "model",
          cloudPlacementSupported: true,
          cloudPlacementExecutionMode: "remote-exec",
        },
        available: true,
        contextWindow: 200_000,
        contextWindows: [
          { id: "64k", label: "64K", contextWindow: 64_000 },
          { id: "200k", label: "200K", contextWindow: 200_000 },
        ],
        contextWindowDefault: "200k",
        thinkingLevels: [{ id: "high", label: "High" }],
        thinkingDefault: "high",
      },
    ],
  },
];

describe("new-session runtime choice", () => {
  it.each([
    { selection: "inherited", model: undefined, agentRuntime: undefined, expected: "High" },
    {
      selection: "saved base model",
      model: "openai/gpt-5.6-sol",
      agentRuntime: undefined,
      expected: "High",
    },
    {
      selection: "explicit alternate",
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
      expected: "Low",
    },
  ])(
    "keeps thinking-default ownership for $selection",
    async ({ model, agentRuntime, expected }) => {
      const levels = [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ];
      const { context } = contextWith([
        {
          ...models[0]!,
          thinkingLevels: levels,
          thinkingDefault: undefined,
          runtimeChoices: [
            { ...models[0]!.runtimeChoices![0]!, thinkingLevels: levels, thinkingDefault: "low" },
          ],
        },
      ]);
      Object.assign(context.sessions.state.result!.defaults, {
        model: "gpt-5.6-sol",
        thinkingLevels: levels,
        thinkingDefault: "high",
      });
      const control = new NewSessionModelControl(() => undefined);
      control.load(context, "main", true, { agent, preference: { model, agentRuntime } });
      try {
        await vi.waitFor(() =>
          expect(
            renderControl(control, context, "main", agent)
              .querySelector('[data-chat-thinking-select="true"]')
              ?.getAttribute("title"),
          ).toBe(expected),
        );
      } finally {
        control.reset();
      }
    },
  );

  it("keeps the same-name runtime choice through preferences and create while using its own capabilities", async () => {
    const { context } = contextWith(models);
    const gatewayUrl = "ws://runtime-choice.example";
    const changed = vi.fn((selection) => patchNewSessionPreference(gatewayUrl, "main", selection));
    const control = new NewSessionModelControl(() => undefined, changed);
    control.load(context, "main", true, { agent });
    try {
      await vi.waitFor(() =>
        expect(
          renderControl(control, context, "main", agent).querySelector(
            '[data-chat-model-runtime="codex"]',
          ),
        ).not.toBeNull(),
      );
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]')!
        .click();
      expect(control.selected).toBe("openai/gpt-5.6-sol");
      expect(control.agentRuntime).toBe("codex");
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>('[data-chat-context-window-toggle="64k"]')!
        .click();
      expect(control.contextWindow).toBe("64k");
      const changesBeforeReselect = changed.mock.calls.length;
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]')!
        .click();
      expect(control.contextWindow).toBe("64k");
      expect(changed).toHaveBeenCalledTimes(changesBeforeReselect);
      expect(control.resolveAgentRuntime({ agent, context })?.cloudPlacementExecutionMode).toBe(
        "remote-exec",
      );
      expect(
        control.cloudRuntimeUnsupportedReason({
          id: "worker",
          providerId: "example",
          executionModes: ["worker-turn"],
        }),
      ).toContain("codex runtime");
      const selected = renderControl(control, context, "main", agent);
      expect(
        selected.querySelectorAll('[data-chat-model-option][aria-selected="true"]'),
      ).toHaveLength(1);
      expect(
        selected.querySelector('[data-chat-model-runtime="codex"]')?.getAttribute("aria-selected"),
      ).toBe("true");
      expect(selected.querySelector('[data-chat-thinking-option="medium"]')).toBeNull();
      expect(loadNewSessionPreference(gatewayUrl, "main")).toMatchObject({
        model: "openai/gpt-5.6-sol",
        agentRuntime: "codex",
      });
      expect(
        buildDraftSessionCreateParams({
          agentId: "main",
          message: "hello",
          worktree: false,
          model: control.modelForSubmission(),
          agentRuntime: control.agentRuntime,
        }),
      ).toMatchObject({ model: "openai/gpt-5.6-sol", agentRuntime: "codex" });
      control.reset();
      control.load(context, "main", true, {
        agent,
        preference: loadNewSessionPreference(gatewayUrl, "main"),
      });
      await vi.waitFor(() => expect(control.agentRuntime).toBe("codex"));
      renderControl(control, context, "main", agent)
        .querySelector<HTMLButtonElement>('[data-chat-model-default="true"]')!
        .click();
      expect(control.modelForSubmission()).toBe("");
      expect(control.agentRuntime).toBeUndefined();
      expect(loadNewSessionPreference(gatewayUrl, "main")?.agentRuntime).toBeUndefined();
    } finally {
      control.reset();
      localStorage.removeItem(`openclaw.new-session.preferences.v1:${gatewayUrl}`);
    }
  });

  it("drops a saved runtime that is no longer offered instead of running it through the base harness", async () => {
    const { runtimeChoices: _choices, ...base } = models[0]!;
    const { context } = contextWith([base]);
    const changed = vi.fn();
    const control = new NewSessionModelControl(() => undefined, changed);
    control.load(context, "main", true, {
      agent,
      preference: { model: "openai/gpt-5.6-sol", agentRuntime: "codex" },
    });
    try {
      await vi.waitFor(() =>
        expect(changed).toHaveBeenCalledWith({ model: "", agentRuntime: "", thinkingLevel: "" }),
      );
      expect(control.agentRuntime).toBeUndefined();
      expect(control.modelForSubmission()).toBe("");
    } finally {
      control.reset();
    }
  });
});
