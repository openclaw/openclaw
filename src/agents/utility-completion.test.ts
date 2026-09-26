// Utility completion carries the execution owner, not HTTP credentials. A
// CLI-backed primary hands its runtime to the auto-derived small model only when
// that model has no usable credential of its own, so these tests always state
// the credential premise rather than inheriting the host's.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { prepareUtilityCompletionForAgent } from "./utility-completion.js";

type AuthProbe = NonNullable<
  Parameters<typeof prepareUtilityCompletionForAgent>[0]["hasProviderAuth"]
>;

/** Records what the credential probe was asked about and answers `available`. */
function authProbe(available: boolean) {
  const calls: Array<{ provider: string; modelId?: string }> = [];
  const fn: AuthProbe = async (probed) => {
    calls.push({
      provider: probed.provider,
      ...(probed.modelId ? { modelId: probed.modelId } : {}),
    });
    return available;
  };
  return { fn, calls };
}

const manifestPlugins = [
  {
    id: "anthropic",
    modelCatalog: {
      providers: {
        anthropic: {
          defaultUtilityModel: "claude-haiku-4-5",
          // claude-sonnet-5 is a same-provider model with no config entry of its
          // own, so it resolves the default HTTP runtime and must stay there.
          models: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
        },
      },
    },
  },
] as unknown as PluginMetadataSnapshot["plugins"];

const cliPrimary = {
  agents: {
    defaults: {
      model: "anthropic/claude-opus-5",
      models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
    },
  },
} as OpenClawConfig;

describe("prepareUtilityCompletionForAgent", () => {
  it("routes the auto-derived utility model through the primary's CLI runtime", async () => {
    const prepared = await prepareUtilityCompletionForAgent({
      cfg: cliPrimary,
      agentId: "main",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: authProbe(false).fn,
    });

    expect(prepared.provider).toBe("anthropic");
    expect(prepared.model).toBe("claude-haiku-4-5");
    expect(prepared).toHaveProperty("agentHarnessRuntimeOverride", "claude-cli");
  });

  // The dual-credential case. Both routes can serve this call, so the one that
  // was already working keeps it: inheriting here would move an installation's
  // digests and titles off API billing and onto CLI subscription quota on
  // upgrade, with no config change on their side.
  it("keeps the derived model on HTTP when the provider already has usable auth", async () => {
    const probe = authProbe(true);

    const prepared = await prepareUtilityCompletionForAgent({
      cfg: cliPrimary,
      agentId: "main",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: probe.fn,
    });

    expect(prepared.provider).toBe("anthropic");
    expect(prepared.model).toBe("claude-haiku-4-5");
    expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
    // The question asked is about the derived route, not the primary's.
    expect(probe.calls).toEqual([{ provider: "anthropic", modelId: "claude-haiku-4-5" }]);
  });

  // session-observer-completion.ts resolves the utility ref itself and passes it
  // back as modelRef, so the override must survive that shape too. Gating on an
  // absent modelRef left the reported path (#138789) unfixed.
  it("routes the session observer's pre-resolved ref through the CLI runtime", async () => {
    const prepared = await prepareUtilityCompletionForAgent({
      cfg: cliPrimary,
      agentId: "main",
      modelRef: "anthropic/claude-haiku-4-5",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: authProbe(false).fn,
    });

    expect(prepared.provider).toBe("anthropic");
    expect(prepared.model).toBe("claude-haiku-4-5");
    expect(prepared).toHaveProperty("agentHarnessRuntimeOverride", "claude-cli");
  });

  it("keeps the session observer's pre-resolved ref on HTTP when auth is available", async () => {
    const prepared = await prepareUtilityCompletionForAgent({
      cfg: cliPrimary,
      agentId: "main",
      modelRef: "anthropic/claude-haiku-4-5",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: authProbe(true).fn,
    });

    expect(prepared.model).toBe("claude-haiku-4-5");
    expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
  });

  // Selection prefers a caller-supplied modelRef over automatic derivation, so
  // useUtilityModel alone does not prove the ref was derived. Inheriting on
  // provider equality alone would move this call off HTTP and onto the primary's
  // CLI subscription quota without any config change.
  it("leaves an explicitly selected same-provider model on its own runtime", async () => {
    const probe = authProbe(false);

    const prepared = await prepareUtilityCompletionForAgent({
      cfg: cliPrimary,
      agentId: "main",
      modelRef: "anthropic/claude-sonnet-5",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: probe.fn,
    });

    expect(prepared.provider).toBe("anthropic");
    expect(prepared.model).toBe("claude-sonnet-5");
    expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(probe.calls).toEqual([]);
  });

  it("leaves an explicit utility model on its own runtime", async () => {
    const cfg = {
      agents: {
        defaults: {
          ...cliPrimary.agents?.defaults,
          utilityModel: "anthropic/claude-haiku-4-5",
        },
      },
    } as OpenClawConfig;
    const probe = authProbe(false);

    const prepared = await prepareUtilityCompletionForAgent({
      cfg,
      agentId: "main",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: probe.fn,
    });

    expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(probe.calls).toEqual([]);
  });

  // No runtime can be inherited here, so the credential lookup must not run at
  // all: this path is every ordinary installation's utility completion, and it
  // should not pay for an auth probe to learn nothing.
  it("leaves a primary on the default runtime alone without probing credentials", async () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-5" } },
    } as OpenClawConfig;
    const probe = authProbe(false);

    const prepared = await prepareUtilityCompletionForAgent({
      cfg,
      agentId: "main",
      useUtilityModel: true,
      manifestPlugins,
      hasProviderAuth: probe.fn,
    });

    expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(probe.calls).toEqual([]);
  });
});
