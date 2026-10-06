import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { checkTouchedTextModelRefs as checkTouchedTextModelRefsRaw } from "./config-model-validation.js";

const checkTouchedTextModelRefs = ({
  config,
  previousConfig,
  ...params
}: Omit<Parameters<typeof checkTouchedTextModelRefsRaw>[0], "config" | "previousConfig"> & {
  config: unknown;
  previousConfig?: unknown;
}) =>
  checkTouchedTextModelRefsRaw({
    ...params,
    config: createCanonicalAgentConfigFixture(config).config,
    ...(previousConfig
      ? {
          previousConfig: createCanonicalAgentConfigFixture(previousConfig).config,
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

  it("rejects an auth-qualified malformed primary before runtime resolution", async () => {
    const primary = "provider/@work";
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
      errors: [expect.stringContaining("Invalid model reference")],
    });
    expect(resolveModelRef).not.toHaveBeenCalled();
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

  it("validates touched fallback and per-agent model refs", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        entries: {
          main: {},
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
    const config: OpenClawConfigWithLegacyRoster = {
      agents: {
        list: [{ id: "ops", default: true, model: "provider-a/model" }],
      },
    };
    const result = await checkTouchedTextModelRefsRaw({
      config,
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
        entries: { main: {} },
      },
    };

    const result = await checkTouchedTextModelRefs({
      config,
      previousConfig: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4-mini" } },
          entries: { main: {} },
        },
      },
      touchedPaths: [["agents", "defaults"]],
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 0, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("revalidates a per-agent model when its entry key changes", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { entries: { next: { model: "provider-a/model" } } },
      },
      previousConfig: {
        agents: { entries: { current: { model: "provider-a/model" } } },
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
          entries: { ops: {} },
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
          entries: { ops: { model: "provider-b/override" } },
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

  it("does not revalidate a default primary that was already inherited", async () => {
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "provider-a/default" } },
          entries: { ops: { model: { fallbacks: ["provider-b/next"] } } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "provider-a/default" } },
          entries: { ops: { model: { fallbacks: ["provider-b/current"] } } },
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
});

function modelConfig(model: { primary?: string; fallbacks?: string[] }): OpenClawConfig {
  return { agents: { defaults: { model } } };
}

describe("config model validation env handling", () => {
  it("reports an authored placeholder without exposing its expanded value", async () => {
    const resolveModelRef = vi.fn(async () => "Unknown model: private-provider/private-model");
    const result = await checkTouchedTextModelRefsRaw({
      config: modelConfig({ primary: "${MODEL_REF}" }),
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { MODEL_REF: "private-provider/private-model@work" },
      resolveModelRef,
    });
    expect(result.errors).toEqual([expect.stringContaining('model reference "${MODEL_REF}"')]);
    expect(result.errors).toEqual([
      expect.stringContaining("Unable to resolve authored model reference"),
    ]);
    expect(result.errors.join("\n")).not.toContain("private-provider");
  });

  it("redacts provider details inherited indirectly from an expanded primary", async () => {
    const resolveModelRef = vi.fn(async ({ ref }: ResolverInput) =>
      ref.fallback ? "Unknown model: private-provider/backup" : undefined,
    );
    const result = await checkTouchedTextModelRefsRaw({
      config: modelConfig({ primary: "${PRIMARY_REF}", fallbacks: ["backup"] }),
      previousConfig: modelConfig({ primary: "provider-a/current", fallbacks: ["backup"] }),
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { PRIMARY_REF: "private-provider/main" },
      resolveModelRef,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('model reference "backup"');
    expect(result.errors[0]).not.toContain("private-provider");
  });

  it("redacts dependency values when authored spelling is unavailable", async () => {
    const resolveModelRef = vi.fn(async ({ ref }: ResolverInput) =>
      ref.fallback ? "Unknown model: provider-b/backup" : undefined,
    );
    const result = await checkTouchedTextModelRefsRaw({
      config: modelConfig({ primary: "provider-b/main", fallbacks: ["backup"] }),
      previousConfig: modelConfig({ primary: "provider-a/main", fallbacks: ["backup"] }),
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      redactDependencyValues: true,
      resolveModelRef,
    });
    expect(result.errors).toEqual([
      expect.stringContaining('model reference "<configured model reference>"'),
    ]);
    expect(result.errors[0]).not.toContain("provider-b");
    expect(result.errors[0]).not.toContain('reference "backup"');
  });

  it("keeps numeric agent ids as object keys when matching unresolved paths", async () => {
    const result = await checkTouchedTextModelRefsRaw({
      config: { agents: { entries: { "123": { model: "${MODEL_REF}" } } } },
      touchedPaths: [["agents", "entries", "123", "model"]],
      env: {},
      resolveModelRef: vi.fn(async () => undefined),
    });

    expect(result.errors).toEqual([expect.stringContaining("unresolved environment variable")]);
  });

  it("does not classify an escaped placeholder literal as unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefsRaw({
      config: modelConfig({ primary: "$${MODEL_REF}" }),
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("rejects an invalid bare fallback when its primary provider is env-unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefsRaw({
      config: modelConfig({ primary: "${MODEL_REF}", fallbacks: [" "] }),
      previousConfig: modelConfig({ primary: "${MODEL_REF}", fallbacks: ["previous"] }),
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({
      refsChecked: 1,
      refsTotal: 1,
      errors: [expect.stringContaining("Model reference is empty")],
    });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("validates a bare fallback when only the primary model is env-unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefsRaw({
      config: modelConfig({ primary: "provider-a/${MODEL_ID}", fallbacks: ["backup"] }),
      previousConfig: modelConfig({ primary: "provider-a/current", fallbacks: ["previous"] }),
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });
});
