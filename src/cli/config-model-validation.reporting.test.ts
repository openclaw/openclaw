import { describe, expect, it, vi } from "vitest";
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

describe("config model validation reporting", () => {
  it("reports the resolver reason for a newly added agent fallback", async () => {
    // A ref the operator just added at an agent path keeps its own spelling, so the
    // resolver's reason reaches them. Marking such a ref as an inherited dependency hid
    // both behind "<configured model reference>" and "Unable to resolve authored model
    // reference", which left a ref that cannot resolve looking like a provider-specific
    // failure rather than the resolver's own diagnosis.
    const reason = "Unknown model: acme/nope";
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => reason);

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
          entries: {
            main: {
              default: true,
              model: {
                primary: "openai/gpt-5.4-mini",
                fallbacks: ["acme/nope"],
              },
            },
          },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
          entries: { main: { default: true, model: { primary: "openai/gpt-5.4-mini" } } },
        },
      },
      touchedPaths: [["agents", "entries", "main", "model"]],
      resolveModelRef,
      redactDependencyValues: true,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(reason);
    expect(result.errors[0]).toContain("at agents.entries.main.model.fallbacks.0");
    expect(result.errors[0]).toContain('"acme/nope"');
    expect(result.errors[0]).not.toContain("<configured model reference>");
    expect(result.errors[0]).not.toContain("Unable to resolve authored model reference");
    expect(resolveModelRef.mock.calls.map(([call]) => call.ref)).toEqual([
      {
        path: "agents.entries.main.model.fallbacks.0",
        value: "acme/nope",
        agentId: "main",
        fallback: true,
      },
    ]);
  });

  it("keeps an inherited dependency ref's value and reason redacted", async () => {
    const resolveModelRef = vi.fn(async ({ ref }: ResolverInput) =>
      ref.path.endsWith("fallbacks.0") ? "Unknown model: provider-a/backup" : undefined,
    );

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "provider-a/default", fallbacks: ["provider-a/backup"] },
          },
          entries: { ops: { default: true } },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: { primary: "provider-a/default", fallbacks: ["provider-a/backup"] },
          },
          entries: { ops: { default: true, model: "provider-b/override" } },
        },
      },
      touchedPaths: [["agents", "entries", "ops", "model"]],
      resolveModelRef,
      redactDependencyValues: true,
    });

    // The agent inherited this ref instead of naming it, so neither the value nor the
    // resolver's words about it are shown; the path is what identifies it.
    expect(result.errors).toEqual([
      'Cannot set model reference "<configured model reference>" at agents.defaults.model.fallbacks.0: Unable to resolve authored model reference. Run openclaw models list to list available models.',
    ]);
  });

  it("keeps the detail suppressed when env resolution rewrote the authored ref", async () => {
    // The resolver saw the substituted value, so its message can quote a value the
    // operator never typed. That case keeps the shorthand reason.
    const resolveModelRef = vi.fn(
      async (_params: ResolverInput) => "Unknown model: deepseek/deepseek-v4-flash",
    );

    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["${PROBE_FALLBACK}"],
            },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks"]],
      env: { PROBE_FALLBACK: "deepseek/deepseek-v4-flash" } as NodeJS.ProcessEnv,
      resolveModelRef,
      redactDependencyValues: true,
    });

    expect(result.errors).toEqual([
      'Cannot set model reference "${PROBE_FALLBACK}" at agents.defaults.model.fallbacks.0: Unable to resolve authored model reference. Run openclaw models list to list available models.',
    ]);
  });
});
