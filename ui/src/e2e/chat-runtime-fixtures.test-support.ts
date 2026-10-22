import type { Locator, Page } from "playwright";
import type { ModelCatalogEntry } from "../api/types.ts";

export function modelAuthStatus(profiles: Record<string, unknown>[], extra = {}) {
  return {
    ts: 1,
    providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles, ...extra }],
  };
}

export function runtimeModel(
  id: string,
  provider: string,
  name: string,
  choices: string[],
  extra: Partial<ModelCatalogEntry> = {},
) {
  return {
    id,
    provider,
    name,
    available: true,
    agentRuntime: { id: "openclaw", source: "model" },
    runtimeChoices: choices.map((runtimeId) => ({
      agentRuntime: { id: runtimeId, source: "model" },
      available: true,
    })),
    ...extra,
  } satisfies ModelCatalogEntry;
}

export function modelPicker(root: Page | Locator) {
  const composer = root.locator(".agent-chat__input").first();
  const picker = composer.locator(".chat-controls__model-picker");
  return {
    composer,
    picker,
    trigger: picker.locator("[data-chat-model-select]"),
    search: picker.locator("[data-chat-model-search]"),
    option: (model: string) => picker.locator(`[data-chat-model-option="${model}"]`),
    runtime: (id: string) => picker.locator(`[data-chat-model-runtime="${id}"]`),
  };
}

export function modelSessionList<T extends Record<string, unknown>>(
  row: T,
  defaults: Record<string, unknown>,
) {
  return { ts: 1, path: "", count: 1, defaults, sessions: [row] };
}

export function runState(active: boolean, runId: string, idleStatus = "done") {
  return {
    activeRunIds: active ? [runId] : [],
    hasActiveRun: active,
    status: active ? "running" : idleStatus,
  };
}
