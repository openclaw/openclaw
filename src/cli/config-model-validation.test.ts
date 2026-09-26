import { beforeEach, describe, expect, it, vi } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { checkTouchedTextModelRefs as checkTouchedTextModelRefsRaw } from "./config-model-validation.js";

const checkTouchedTextModelRefs: typeof checkTouchedTextModelRefsRaw = (params) =>
  checkTouchedTextModelRefsRaw({
    ...params,
    config: migratePersistedImplicitMainRoster(params.config).config as OpenClawConfig,
    ...(params.previousConfig
      ? {
          previousConfig: migratePersistedImplicitMainRoster(params.previousConfig)
            .config as OpenClawConfig,
        }
      : {}),
  });

type ResolverInput = {
  config: OpenClawConfig;
  ref: {
    path: string;
    value: string;
    agentId?: string;
    fallback: boolean;
    authProfileId?: string;
  };
};

describe("config model validation", () => {
  const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
  beforeEach(() => resolveModelRef.mockClear());

  it("rejects an unresolved default primary with an actionable error", async () => {
    const rejectModelRef = vi.fn(async () => "Unknown model: missing/nope");

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "missing/nope" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef: rejectModelRef,
    });

    expect(result).toEqual({
      refsChecked: 1,
      refsTotal: 1,
      errors: [
        'Cannot set model reference "missing/nope" at agents.defaults.model.primary: Unknown model: missing/nope. Run openclaw models list to list available models.',
      ],
    });
  });

  it("accepts a primary that resembles the old validation sentinel", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "provider/__openclaw_config_validation_unresolved_model__" },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("validates default refs in every inheriting agent catalog", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
          entries: { main: {}, ops: {} },
        },
      },
      touchedPaths: [["agents", "defaults", "model"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 4, refsTotal: 4, errors: [] });
    expect(
      resolveModelRef.mock.calls.map(([call]) => ({
        path: call.ref.path,
        agentId: call.ref.agentId,
      })),
    ).toEqual([
      { path: "agents.defaults.model.primary", agentId: "main" },
      { path: "agents.defaults.model.primary", agentId: "ops" },
      { path: "agents.defaults.model.fallbacks.0", agentId: "main" },
      { path: "agents.defaults.model.fallbacks.0", agentId: "ops" },
    ]);
  });

  it("skips the default-agent catalog when that agent overrides the default", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "provider-a/default" } },
          entries: {
            main: { model: "provider-b/override" },
            ops: {},
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.defaults.model.primary",
        value: "provider-a/default",
        agentId: "ops",
        fallback: false,
      },
    });
  });

  it("carries a primary auth profile into runtime resolution", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4-mini@work" } },
          entries: { main: {} },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4-mini@work" } },
          entries: { main: {} },
        },
      },
      ref: {
        path: "agents.defaults.model.primary",
        value: "openai/gpt-5.4-mini@work",
        fallback: false,
        authProfileId: "work",
      },
    });
  });

  it.each([
    ["missing/", "Invalid model reference"],
    ["provider/@work", "Invalid model reference"],
    ["", "Model reference is empty"],
  ])("rejects the malformed primary %j before runtime resolution", async (primary, detail) => {
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

  const primaryCases: Array<{
    name: string;
    primary: string;
    models: Record<string, { alias?: string }>;
    authProfileId?: string;
  }> = [
    {
      name: "allows a configured alias with slash-edge syntax",
      primary: "legacy/",
      models: { "openai/gpt-5.4-mini": { alias: "legacy/" } },
    },
    {
      name: "allows an auth-qualified configured alias with slash-edge syntax",
      primary: "legacy/@work",
      models: { "openai/gpt-5.4-mini": { alias: "legacy/" } },
      authProfileId: "work",
    },
    {
      name: "preserves exact alias precedence for an auth-shaped alias",
      primary: "legacy/@work",
      models: { "openai/gpt-5.4-mini": { alias: "legacy/@work" } },
      authProfileId: "work",
    },
    {
      name: "accepts a configured alias whose target is a valid bare model",
      primary: "fast",
      models: { "gpt-5": { alias: "fast" } },
    },
    {
      name: "uses the canonical valid target when duplicate aliases exist",
      primary: "fast",
      models: { "broken/": { alias: "fast" }, "provider/good": { alias: "fast" } },
    },
    {
      name: "passes a configured bare primary model to runtime resolution",
      primary: "foo",
      models: { "acme-cli/foo": {} },
    },
    {
      name: "keeps an explicit qualified primary ahead of a same-named bare alias",
      primary: "acme-cli/foo",
      models: { bar: { alias: "acme-cli/foo" } },
    },
  ];

  it.each(primaryCases)("$name", async ({ primary, models, authProfileId }) => {
    const result = await checkTouchedTextModelRefs({
      config: { agents: { defaults: { model: { primary }, models } } },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledExactlyOnceWith({
      config: expect.any(Object),
      ref: {
        path: "agents.defaults.model.primary",
        value: primary,
        fallback: false,
        ...(authProfileId ? { authProfileId } : {}),
      },
    });
  });

  it("rejects a configured alias whose target is malformed", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "legacy/" },
            models: { "broken/": { alias: "legacy/" } },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result.errors).toEqual([expect.stringContaining("Invalid model reference")]);
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("matches runtime fallback behavior by not selecting an auth profile", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["anthropic/claude-sonnet-4-6@work"],
            },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.defaults.model.fallbacks.0",
        value: "anthropic/claude-sonnet-4-6@work",
        fallback: true,
      },
    });
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

  it("ignores a nonempty array in the agent-entry map draft", async () => {
    const config = { agents: { entries: [{ model: "missing/model" }] } };
    const result = await checkTouchedTextModelRefs({
      config: config as unknown as OpenClawConfig,
      touchedPaths: [["agents", "entries"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("collects every unresolved ref in a multi-reference update", async () => {
    const rejectModelRef = vi.fn(
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
      resolveModelRef: rejectModelRef,
    });

    expect(result.refsChecked).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(rejectModelRef).toHaveBeenCalledTimes(2);
  });

  it("revalidates default and per-agent fallbacks when the default provider changes", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "provider-b/main",
            fallbacks: ["backup", "provider-a/qualified-backup"],
          },
        },
        entries: {
          main: {},
          ops: {
            model: {
              primary: "provider-c/main",
              fallbacks: ["agent-backup", "provider-c/qualified-agent-backup"],
            },
          },
        },
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
      "agents.entries.ops.model.fallbacks.0",
    ]);
  });

  it("revalidates a slash-shaped alias whose bare target changes provider", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "provider-b/main",
            fallbacks: ["legacy/"],
          },
          models: { "gpt-5": { alias: "legacy/" } },
        },
        entries: { main: { default: true } },
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
              fallbacks: ["legacy/"],
            },
          },
          entries: { main: { default: true } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref.path)).toEqual([
      "agents.defaults.model.primary",
      "agents.defaults.model.fallbacks.0",
    ]);
  });

  it("does not revalidate bare fallbacks when only the default model changes", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "provider-a/next",
            fallbacks: ["backup"],
          },
        },
        entries: { ops: { default: true, model: { fallbacks: ["agent-backup"] } } },
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

  it("revalidates fallbacks when roster repair also changes an ambiguous default provider", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "provider-b/main", fallbacks: ["backup"] },
          },
          entries: {
            main: { default: true },
            ops: {},
          },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: { primary: "provider-a/main", fallbacks: ["backup"] },
          },
          entries: {
            main: { default: true },
            ops: { default: true },
          },
        },
      },
      touchedPaths: [
        ["agents", "defaults", "model", "primary"],
        ["agents", "entries", "ops", "default"],
      ],
      resolveModelRef,
    });

    expect(result.errors).toEqual([]);
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref.path)).toContain(
      "agents.defaults.model.fallbacks.0",
    );
  });

  it("validates touched fallback and per-agent model refs", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        entries: {
          main: { default: true },
          ops: { model: { primary: "google/gemini-3.1-pro-preview" } },
        },
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      touchedPaths: [
        ["agents", "defaults", "model", "fallbacks"],
        ["agents", "entries", "ops", "model", "primary"],
      ],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref)).toEqual([
      {
        path: "agents.defaults.model.fallbacks.0",
        value: "anthropic/claude-sonnet-4-6",
        agentId: "main",
        fallback: true,
      },
      {
        path: "agents.entries.ops.model.primary",
        value: "google/gemini-3.1-pro-preview",
        agentId: "ops",
        fallback: false,
      },
    ]);
  });

  it("uses list index paths for list-shaped agent model refs", async () => {
    const result = await checkTouchedTextModelRefsRaw({
      config: {
        agents: {
          list: [{ id: "ops", default: true, model: "provider-a/model" }],
        },
      },
      touchedPaths: [["agents", "list", "0", "model"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.list.0.model",
        value: "provider-a/model",
        agentId: "ops",
        fallback: false,
      },
    });
  });

  it("does not validate unrelated or media model keys", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4-mini" },
            mediaModels: { video: { primary: "qwen/wan2.6-t2v" } },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "mediaModels", "video", "primary"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("does not revalidate unchanged refs under an ancestor merge", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4-mini" },
          workspace: "/tmp/next-workspace",
        },
        entries: { main: { default: true } },
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      previousConfig: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4-mini" } },
          entries: { main: { default: true } },
        },
      },
      touchedPaths: [["agents", "defaults"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("revalidates per-agent refs when entry model ownership changes", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          entries: {
            beta: { default: true, model: "provider-a/model" },
            alpha: { model: "provider-b/model" },
          },
        },
      },
      previousConfig: {
        agents: {
          entries: {
            alpha: { default: true, model: "provider-a/model" },
            beta: { model: "provider-b/model" },
          },
        },
      },
      touchedPaths: [["agents", "entries"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref.agentId)).toEqual(["beta", "alpha"]);
  });

  it("does not revalidate a retained agent model when another entry is removed", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { entries: { beta: { default: true, model: "provider-b/model" } } },
      },
      previousConfig: {
        agents: {
          entries: {
            alpha: { default: true, model: "provider-a/model" },
            beta: { model: "provider-b/model" },
          },
        },
      },
      touchedPaths: [["agents", "entries", "alpha"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("revalidates a per-agent model when its entry key changes", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { entries: { next: { default: true, model: "provider-a/model" } } },
      },
      previousConfig: {
        agents: { entries: { current: { default: true, model: "provider-a/model" } } },
      },
      touchedPaths: [["agents", "entries"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.entries.next.model",
        value: "provider-a/model",
        agentId: "next",
        fallback: false,
        dependency: true,
      },
    });
  });

  it("validates defaults newly inherited after removing an agent model override", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "provider-a/default",
              fallbacks: ["provider-a/backup"],
            },
          },
          entries: { ops: { default: true } },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: {
              primary: "provider-a/default",
              fallbacks: ["provider-a/backup"],
            },
          },
          entries: { ops: { default: true, model: "provider-b/override" } },
        },
      },
      touchedPaths: [["agents", "entries", "ops", "model"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref)).toEqual([
      {
        path: "agents.defaults.model.primary",
        value: "provider-a/default",
        agentId: "ops",
        fallback: false,
        dependency: true,
      },
      {
        path: "agents.defaults.model.fallbacks.0",
        value: "provider-a/backup",
        agentId: "ops",
        fallback: true,
        dependency: true,
      },
    ]);
  });

  it("validates inherited defaults when a leaf write creates an agent entry", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "provider-a/default",
              fallbacks: ["provider-a/backup"],
            },
          },
          entries: { ops: { default: true, workspace: "/tmp/ops" } },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: {
              primary: "provider-a/default",
              fallbacks: ["provider-a/backup"],
            },
          },
          entries: { main: { default: true } },
        },
      },
      touchedPaths: [["agents", "entries", "ops", "workspace"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref.agentId)).toEqual(["ops", "ops"]);
  });

  it("does not revalidate a default primary that was already inherited", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "provider-a/default" } },
          entries: { ops: { default: true, model: { fallbacks: ["provider-b/next"] } } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "provider-a/default" } },
          entries: { ops: { default: true, model: { fallbacks: ["provider-b/current"] } } },
        },
      },
      touchedPaths: [["agents", "entries", "ops", "model", "fallbacks"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.entries.ops.model.fallbacks.0",
        value: "provider-b/next",
        agentId: "ops",
        fallback: true,
      },
    });
  });

  it("leaves malformed roster drafts to schema validation", async () => {
    for (const entries of [
      [] as never,
      { bad: null } as never,
      { main: { default: true }, ops: { default: true } },
    ]) {
      await expect(
        checkTouchedTextModelRefsRaw({
          config: { agents: { entries } },
          touchedPaths: [["agents", "entries"]],
          resolveModelRef,
        }),
      ).resolves.toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    }
    expect(resolveModelRef).not.toHaveBeenCalled();
  });
});
