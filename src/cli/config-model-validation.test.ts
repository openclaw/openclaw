import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { checkTouchedTextModelRefs } from "./config-model-validation.js";

type ResolverInput = {
  config: OpenClawConfig;
  ref: {
    path: string;
    value: string;
    agentIndex?: number;
    fallback: boolean;
    authProfileId?: string;
  };
};

describe("config model validation", () => {
  it("rejects an unresolved default primary with an actionable error", async () => {
    const resolveModelRef = vi.fn(async () => "Unknown model: missing/nope");

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "missing/nope" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({
      refsChecked: 1,
      refsTotal: 1,
      errors: [
        'Cannot set model reference "missing/nope" at agents.defaults.model.primary: Unknown model: missing/nope. Run openclaw models list to list available models.',
      ],
    });
  });

  it("accepts a resolved default primary", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(resolveModelRef).toHaveBeenCalledOnce();
    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
  });

  it("carries a primary auth profile into runtime resolution", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini@work" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini@work" } } },
      },
      ref: {
        path: "agents.defaults.model.primary",
        value: "openai/gpt-5.4-mini@work",
        fallback: false,
        authProfileId: "work",
      },
    });
  });

  it("validates an env-expanded model ref while preserving the authored config", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "${MODEL_REF}" } } },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { MODEL_REF: "openai/gpt-5.4-mini" },
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } } },
      ref: {
        path: "agents.defaults.model.primary",
        value: "openai/gpt-5.4-mini",
        fallback: false,
      },
    });
    expect(config.agents?.defaults?.model).toEqual({ primary: "${MODEL_REF}" });
  });

  it.each([
    ["missing/", "Invalid model reference"],
    ["provider/@work", "Invalid model reference"],
    ["", "Model reference is empty"],
  ])("rejects the malformed primary %j before runtime resolution", async (primary, detail) => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({
      refsChecked: 1,
      refsTotal: 1,
      errors: [expect.stringContaining(detail)],
    });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("allows a configured alias with slash-edge syntax", async () => {
    const resolveModelRef = vi.fn(async () => undefined);

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "legacy/" },
            models: { "openai/gpt-5.4-mini": { alias: "legacy/" } },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("accepts a configured CLI backend model without an embedded catalog row", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "acme-cli/foo" },
            cliBackends: { "acme-cli": { command: "acme" } },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
  });

  it("reports resolver setup failures without claiming refs were checked", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      createModelRefResolver: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(result).toEqual({
      refsChecked: 0,
      refsTotal: 1,
      errors: ["Unable to validate changed model references before writing: catalog unavailable"],
    });
  });

  it("does not count a thrown resolver call as checked", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(result).toEqual({
      refsChecked: 0,
      refsTotal: 1,
      errors: [expect.stringContaining("Unable to validate model reference: catalog unavailable")],
    });
  });

  it.each([{ agents: { list: {} } }, { agents: { list: [null] } }])(
    "ignores schema-invalid agent-list draft values",
    async (config) => {
      const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);

      const result = await checkTouchedTextModelRefs({
        config: config as unknown as OpenClawConfig,
        touchedPaths: [["agents", "list"]],
        resolveModelRef,
      });

      expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
      expect(resolveModelRef).not.toHaveBeenCalled();
    },
  );

  it("rejects an unresolved default fallback", async () => {
    const resolveModelRef = vi.fn(async () => "Unknown model: missing/fallback");

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["missing/fallback"],
            },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      resolveModelRef,
    });

    expect(result.errors).toEqual([
      expect.stringContaining(
        'Cannot set model reference "missing/fallback" at agents.defaults.model.fallbacks.0',
      ),
    ]);
  });

  it("collects every unresolved ref in a multi-reference update", async () => {
    const resolveModelRef = vi.fn(
      async ({ ref }: { ref: { value: string } }) => `Unknown model: ${ref.value}`,
    );

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "missing/primary",
              fallbacks: ["missing/fallback"],
            },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model"]],
      resolveModelRef,
    });

    expect(result.refsChecked).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(resolveModelRef).toHaveBeenCalledTimes(2);
  });

  it("revalidates default and per-agent fallbacks when the default provider changes", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "provider-b/main",
            fallbacks: ["backup", "provider-a/qualified-backup"],
          },
        },
        list: [
          {
            id: "ops",
            model: {
              primary: "provider-c/main",
              fallbacks: ["agent-backup", "provider-c/qualified-agent-backup"],
            },
          },
        ],
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      previousConfig: {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: {
              primary: "provider-a/main",
              fallbacks: ["backup", "provider-a/qualified-backup"],
            },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result.refsChecked).toBe(3);
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref.path)).toEqual([
      "agents.defaults.model.primary",
      "agents.defaults.model.fallbacks.0",
      "agents.list.0.model.fallbacks.0",
    ]);
  });

  it("does not revalidate bare fallbacks when only the default model changes", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "provider-a/next",
            fallbacks: ["backup"],
          },
        },
        list: [{ id: "ops", model: { fallbacks: ["agent-backup"] } }],
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      previousConfig: {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: {
              primary: "provider-a/current",
              fallbacks: ["backup"],
            },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref.path)).toEqual([
      "agents.defaults.model.primary",
    ]);
  });

  it("validates touched fallback and per-agent model refs", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [{ id: "ops", model: { primary: "google/gemini-3.1-pro-preview" } }],
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      touchedPaths: [
        ["agents", "defaults", "model", "fallbacks"],
        ["agents", "list", "0", "model", "primary"],
      ],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref)).toEqual([
      {
        path: "agents.defaults.model.fallbacks.0",
        value: "anthropic/claude-sonnet-4-6",
        fallback: true,
      },
      {
        path: "agents.list.0.model.primary",
        value: "google/gemini-3.1-pro-preview",
        agentIndex: 0,
        fallback: false,
      },
    ]);
  });

  it("does not validate unrelated or media model keys", async () => {
    const resolveModelRef = vi.fn(async () => undefined);

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4-mini" },
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "videoGenerationModel", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("does not revalidate unchanged refs under an ancestor merge", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4-mini" },
          workspace: "/tmp/next-workspace",
        },
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      previousConfig: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
      },
      touchedPaths: [["agents", "defaults"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });
});
