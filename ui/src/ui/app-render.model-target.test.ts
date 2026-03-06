import { describe, expect, it } from "vitest";
import { resolveAgentModelTarget } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

function createState(
  configForm: Record<string, unknown>,
  defaultAgentId = "main",
): AppViewState {
  return {
    agentsList: {
      defaultId: defaultAgentId,
      agents: [],
    },
    configForm,
    configSnapshot: null,
    configFormDirty: false,
    configFormMode: "form",
    configRaw: "{}",
  } as unknown as AppViewState;
}

describe("resolveAgentModelTarget", () => {
  it("uses agents.defaults.model for the default agent", () => {
    const configForm: Record<string, unknown> = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
        list: [],
      },
    };
    const state = createState(configForm, "main");

    const target = resolveAgentModelTarget(state, configForm, "main");

    expect(target?.basePath).toEqual(["agents", "defaults", "model"]);
    expect(target?.existingModel).toBe("openai/gpt-5");
    expect(state.configFormDirty).toBe(false);
  });

  it("upserts missing non-default agents into agents.list", () => {
    const configForm: Record<string, unknown> = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
        list: [],
      },
    };
    const state = createState(configForm, "main");

    const target = resolveAgentModelTarget(state, configForm, "ops");

    expect(target?.basePath).toEqual(["agents", "list", 0, "model"]);
    expect(target?.existingModel).toBeUndefined();
    expect(state.configFormDirty).toBe(true);
    const list = ((state.configForm?.agents as { list?: unknown[] } | undefined)?.list ?? []) as Array<
      { id?: string }
    >;
    expect(list[0]?.id).toBe("ops");
  });
});
