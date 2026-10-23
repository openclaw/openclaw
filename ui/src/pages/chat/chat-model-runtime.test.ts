/* @vitest-environment jsdom */

import { createComponent, createSignal, merge } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { switchChatModel } from "./chat-session.ts";
import { ChatModelControls } from "./components/chat-model-controls.tsx";

const codexChoice = {
  agentRuntime: { id: "codex", source: "model" },
  available: true,
} satisfies NonNullable<ModelCatalogEntry["runtimeChoices"]>[number];
const codexSelector = '[data-chat-model-runtime="codex"]';
const solSelector = '[data-chat-model-option="openai/gpt-5.6-sol"]';
const model: ModelCatalogEntry = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  available: true,
  agentRuntime: { id: "openclaw", source: "model" },
  runtimeChoices: [codexChoice],
};

type ModelControlsProps = Parameters<typeof ChatModelControls>[0];
const mountedControls = new WeakMap<HTMLElement, (props: ModelControlsProps) => void>();

async function renderControls(
  result: SessionsListResult,
  models: ModelCatalogEntry[],
  options: Pick<ModelControlsProps, "onModelSelect" | "onModelSetup" | "modelSelectionLocked"> = {},
  container = document.createElement("div"),
) {
  const props: ModelControlsProps = {
    activeRunId: null,
    connected: true,
    gatewayAvailable: true,
    loading: false,
    modelCatalog: models,
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    modelSwitching: false,
    modelPickerOpen: true,
    sending: false,
    sessionKey: "main",
    selectedSession: result.sessions[0],
    sessionsResult: result,
    stream: null,
    ...options,
  };
  const update = mountedControls.get(container);
  if (update) {
    update(props);
  } else {
    document.body.append(container);
    const [current, setCurrent] = createSignal(props);
    const view = mountSolid(() => createComponent(ChatModelControls, merge(current)), {
      container,
    });
    mountedControls.set(container, setCurrent);
    onTestFinished(() => {
      view.unmount();
      mountedControls.delete(container);
      container.remove();
    });
  }
  flush();
  await waitForSolid(() =>
    expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
  );
  return container;
}

function renderRuntimeModel(
  entry: ModelCatalogEntry,
  selectedRuntime?: string,
  observedModel = false,
) {
  const result = createSessionsListResult({
    model: entry.id,
    modelProvider: entry.provider,
    defaultsModel: entry.id,
    defaultsProvider: entry.provider,
  });
  if (selectedRuntime) {
    result.sessions[0]!.agentRuntime = { id: selectedRuntime, source: "session-key" };
  }
  if (observedModel) {
    result.sessions[0]!.activeModel = entry.id;
    result.sessions[0]!.activeModelProvider = entry.provider;
  }
  return renderControls(result, [entry]);
}

function selectionControls(result: SessionsListResult, models: ModelCatalogEntry[]) {
  const host = makeChatHost({
    sessionKey: "main",
    sessionsResult: result,
    chatModelCatalog: models,
    chatModelSwitchPromises: {},
    requestHandlers: {
      "sessions.patch": { ok: true, key: "main", path: "", entry: { sessionId: "main" } },
      "sessions.list": result,
    },
  });
  onTestFinished(() => host.sessions.dispose());
  const container = document.createElement("div");
  let selection: Promise<boolean> | undefined;
  const draw = () =>
    renderControls(
      result,
      models,
      {
        onModelSelect: (value, key, runtime) => {
          selection = switchChatModel(host, value, key, runtime);
          return selection;
        },
      },
      container,
    );
  const row = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;
  return {
    host,
    container,
    draw,
    row,
    select: async (button: HTMLButtonElement) => {
      button.click();
      await selection;
    },
    patches: () => requestCalls(host.request, "sessions.patch"),
  };
}

const triggerLabel = (container: HTMLElement) =>
  container.querySelector(".chat-controls__inline-select-label")?.textContent?.trim();
const optionName = (row: Element) =>
  row.querySelector(".chat-controls__model-option-name")?.textContent;
function expectPatch(
  host: ReturnType<typeof selectionControls>["host"],
  patch: Record<string, unknown>,
) {
  expect(host.request).toHaveBeenCalledWith("sessions.patch", { key: "main", ...patch });
}

describe("chat model runtime choices", () => {
  it("keeps an automatic-only model's name on a runtime reset", async () => {
    const container = await renderRuntimeModel(
      { id: "automatic", name: "Automatic", provider: "fixture", manualSelectionAllowed: false },
      "openclaw",
    );
    expect(container.querySelector("[data-chat-model-default]")).not.toBeNull();
    expect(triggerLabel(container)).toBe("Automatic");
  });

  it.each([false, true])(
    "preserves runtime selection when changing only the model (locked: %s)",
    async (runtimeLocked) => {
      const defaultModel: ModelCatalogEntry = {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        agentRuntime: { id: "openclaw", source: "model" },
      };
      const customModel: ModelCatalogEntry = {
        ...model,
        agentRuntime: { id: "custom-harness", source: "model" },
      };
      const models = [defaultModel, customModel];
      const result = createSessionsListResult({
        model: defaultModel.id,
        defaultsModel: defaultModel.id,
        modelOverrideSource: null,
      });
      result.sessions[0]!.agentRuntime = runtimeLocked
        ? { id: "acpx", source: "session-key" }
        : defaultModel.agentRuntime;
      result.sessions[0]!.runtimeSelectionLocked = runtimeLocked || undefined;
      const { host, container, draw, row, select, patches } = selectionControls(result, models);
      await draw();
      const rows = container.querySelectorAll<HTMLButtonElement>(solSelector);
      await select(rows[0]!);
      expectPatch(host, {
        model: "openai/gpt-5.6-sol",
        ...(runtimeLocked ? {} : { agentRuntime: null }),
      });
      expect(Array.from(rows, optionName)).toEqual(
        runtimeLocked ? ["GPT-5.6 Sol"] : ["GPT-5.6 Sol", "GPT-5.6 Sol"],
      );
      expect(rows[0]?.getAttribute("data-chat-model-default")).toBeNull();
      expect(rows[0]?.getAttribute("data-chat-model-runtime")).toBe(
        runtimeLocked ? null : "custom-harness",
      );
      result.sessions[0]!.model = customModel.id;
      result.sessions[0]!.modelOverrideSource = "user";
      result.sessions[0]!.agentRuntime = runtimeLocked
        ? { id: "acpx", source: "session-key" }
        : customModel.agentRuntime;
      await draw();
      if (runtimeLocked) {
        expect(container.querySelector(codexSelector)).toBeNull();
        await select(row('[data-chat-model-default="true"]'));
        expectPatch(host, { model: null });
        return;
      }
      await select(row(codexSelector));
      expectPatch(host, { model: "openai/gpt-5.6-sol", agentRuntime: "codex" });
      result.sessions[0]!.agentRuntime = { id: "codex", source: "session-key" };
      customModel.runtimeChoices = undefined;
      await draw();
      expect(triggerLabel(container)).toBe("GPT-5.6 Sol");
      const patchesBeforeReset = patches().length;
      await select(row(solSelector));
      expect(patches()).toHaveLength(patchesBeforeReset);
    },
  );

  it("selects exactly one row with absent base runtime metadata", async () => {
    const { agentRuntime: _runtime, ...unknownRuntimeModel } = model;
    const container = await renderRuntimeModel({
      ...unknownRuntimeModel,
      runtimeChoices: [
        codexChoice,
        { agentRuntime: { id: "openclaw", source: "model" }, available: true },
      ],
    });
    expect(container.querySelectorAll("[data-chat-model-runtime]")).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-chat-model-runtime][aria-selected="true"]'),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-chat-model-option][aria-selected="true"]'),
    ).toHaveLength(1);
  });

  it("uses the selected harness capability for the model trigger", async () => {
    const container = await renderRuntimeModel(
      {
        ...model,
        supportsTools: true,
        runtimeChoices: [{ ...codexChoice, supportsTools: false }],
      },
      "codex",
    );
    expect(
      container.querySelector("[data-chat-model-select]")?.getAttribute("data-chat-model-tools"),
    ).toBe("unavailable");
    expect(
      container.querySelector(".chat-controls__model-capability-badge")?.textContent,
    ).toContain("Chat only");
  });

  it("labels an observed Codex default with an alternate runtime", async () => {
    const container = await renderRuntimeModel(
      {
        ...model,
        agentRuntime: { id: "codex", source: "implicit" },
        runtimeChoices: [{ agentRuntime: { id: "openclaw", source: "model" }, available: true }],
      },
      "codex",
      true,
    );
    expect(
      Array.from(
        container.querySelectorAll(".chat-controls__model-option-name"),
        (row) => row.textContent,
      ),
    ).toEqual(["GPT-5.6 Sol codex", "GPT-5.6 Sol"]);
    expect(triggerLabel(container)).toBe("GPT-5.6 Sol codex");
  });

  it("uses alternate thinking metadata when the base runtime identity is absent", async () => {
    const { agentRuntime: _runtime, ...unknownRuntimeModel } = model;
    const container = await renderRuntimeModel(
      {
        ...unknownRuntimeModel,
        thinkingLevels: [{ id: "medium", label: "Medium" }],
        thinkingDefault: "medium",
        runtimeChoices: [
          {
            ...codexChoice,
            thinkingLevels: [{ id: "high", label: "High" }],
            thinkingDefault: "high",
          },
        ],
      },
      "codex",
    );
    container.querySelector<HTMLElement>(".chat-controls__effort-picker summary")!.click();
    await waitForSolid(() =>
      expect(container.querySelector('[data-chat-thinking-option="high"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-chat-thinking-option="medium"]')).toBeNull();
  });

  it.each(["missing-auth", "unsupported-runtime", "locked"] as const)(
    "preserves the %s guard for additional harness rows",
    async (guard) => {
      const onSelect = vi.fn();
      const onSetup = vi.fn();
      const result = createSessionsListResult({ model: model.id, defaultsModel: model.id });
      result.sessions[0]!.agentRuntime = model.agentRuntime;
      const container = await renderControls(
        result,
        [
          {
            ...model,
            runtimeChoices: [
              {
                ...codexChoice,
                available: false,
                ...(guard === "locked" ? {} : { unavailableReason: guard }),
              },
            ],
          },
        ],
        {
          modelSelectionLocked: guard === "locked",
          onModelSelect: onSelect,
          onModelSetup: onSetup,
        },
      );
      const row = container.querySelector<HTMLButtonElement>(codexSelector);
      if (guard === "locked") {
        expect(row).toBeNull();
      } else {
        expect(row && optionName(row)).toBe("GPT-5.6 Sol codex");
        expect(row?.disabled).toBe(guard === "unsupported-runtime");
        if (guard === "unsupported-runtime") {
          expect(row?.title).toBe("This harness is unavailable for this model.");
        }
        row?.click();
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onSetup).toHaveBeenCalledTimes(guard === "missing-auth" ? 1 : 0);
    },
  );
});
