/** Claims a ClawHub promotion: configures provider auth and registers its models. */
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { hasAvailableAuthForProvider } from "../../agents/model-auth.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { promptYesNo } from "../../cli/prompt.js";
import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ClawHubRequestError,
  fetchClawHubPromotion,
  type ClawHubPromotion,
} from "../../infra/clawhub.js";
import { applyAuthChoiceLoadedPluginProvider } from "../../plugins/provider-auth-choice.js";
import {
  resolveManifestProviderAuthChoice,
  type ProviderAuthChoiceMetadata,
} from "../../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntry } from "../../plugins/provider-install-catalog.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { normalizeAlias } from "../models/alias-name.js";
import {
  applyDefaultModelPrimaryUpdate,
  updateConfig,
  upsertCanonicalModelConfigEntry,
} from "../models/shared.js";

export type PromosClaimOptions = {
  apiKey?: string;
  setDefault?: boolean;
};

// Promo models must belong to the promotion's declared provider. This keeps the
// payload declarative: a record can never register models under a provider the
// user did not just validate/authenticate against.
function resolvePromotionModelTarget(promotion: ClawHubPromotion, modelRef: string) {
  const provider = promotion.provider ?? "";
  const prefix = `${provider}/`;
  if (!modelRef.startsWith(prefix) || modelRef.length <= prefix.length) {
    throw new Error(
      `Promotion "${promotion.slug}" lists model "${modelRef}" outside its provider "${provider}"; refusing to configure it.`,
    );
  }
  return { provider, model: modelRef.slice(prefix.length) };
}

async function fetchLivePromotion(slug: string): Promise<ClawHubPromotion> {
  try {
    return await fetchClawHubPromotion({ slug });
  } catch (error) {
    if (error instanceof ClawHubRequestError && error.status === 404) {
      throw new Error(
        `Promotion "${slug}" was not found or is not live. See ${formatCliCommand("openclaw promos list")}.`,
      );
    }
    throw error;
  }
}

// Enforce the window client-side; the server-provided `active` flag is only an
// additional signal, never a bypass — a stale or hostile payload must not
// register expired or unlaunched offers.
function requireLiveWindow(promotion: ClawHubPromotion) {
  const now = Date.now();
  if (now > promotion.endsAt) {
    throw new Error(
      `Promotion "${promotion.slug}" ended on ${new Date(promotion.endsAt).toLocaleDateString()}.`,
    );
  }
  if (now < promotion.startsAt || !promotion.active) {
    throw new Error(`Promotion "${promotion.slug}" is not live yet.`);
  }
}

// Mirrors applyAuthChoiceLoadedPluginProvider's own resolution order: loaded
// plugin manifests (bundled/installed providers) first, then the install
// catalog for providers that would need a plugin install.
function resolveAuthChoice(
  promotion: ClawHubPromotion,
  provider: string,
  cfg: OpenClawConfig,
): ProviderAuthChoiceMetadata | undefined {
  const authChoiceId = promotion.authChoiceId?.trim();
  if (!authChoiceId) {
    return undefined;
  }
  const entry =
    resolveManifestProviderAuthChoice(authChoiceId, {
      config: cfg,
      includeUntrustedWorkspacePlugins: false,
    }) ??
    resolveProviderInstallCatalogEntry(authChoiceId, {
      config: cfg,
      includeUntrustedWorkspacePlugins: false,
    });
  if (!entry) {
    throw new Error(
      `Promotion "${promotion.slug}" requires auth choice "${authChoiceId}", which this OpenClaw version does not know. Update OpenClaw and retry.`,
    );
  }
  if (entry.providerId !== provider) {
    throw new Error(
      `Promotion "${promotion.slug}" declares provider "${provider}" but its auth choice belongs to "${entry.providerId}"; refusing to configure it.`,
    );
  }
  return entry;
}

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

async function readValidConfigSnapshot(): Promise<ConfigSnapshot> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  return snapshot;
}

async function ensureProviderAuth(params: {
  promotion: ClawHubPromotion;
  provider: string;
  catalogEntry: ProviderAuthChoiceMetadata | undefined;
  snapshot: ConfigSnapshot;
  opts: PromosClaimOptions;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { promotion, provider, catalogEntry, snapshot, opts, runtime } = params;
  const runtimeConfig = snapshot.runtimeConfig ?? snapshot.config;
  const apiKey = opts.apiKey?.trim();
  // Any working provider auth is deliberately sufficient: the promotion's
  // authChoiceId describes how to set up auth when none exists, not an
  // exclusivity requirement. An explicit --api-key overrides reuse because the
  // user asked for that specific key to be stored.
  if (!apiKey && (await hasAvailableAuthForProvider({ provider, cfg: runtimeConfig }))) {
    runtime.log(`Using your existing ${provider} credentials.`);
    return;
  }
  if (!catalogEntry) {
    throw new Error(
      `No credentials configured for provider "${provider}". Add one with ${formatCliCommand("openclaw models auth add")} and retry.`,
    );
  }
  if (promotion.signupUrl) {
    runtime.log(`Get a free key for this promotion: ${sanitizeTerminalText(promotion.signupUrl)}`);
  }
  if (apiKey && !catalogEntry.optionKey) {
    throw new Error(
      `Auth choice "${catalogEntry.choiceId}" does not accept --api-key; run without it to authenticate interactively.`,
    );
  }
  const applied = await applyAuthChoiceLoadedPluginProvider({
    authChoice: catalogEntry.choiceId,
    config: structuredClone(snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig,
    prompter: createClackPrompter(),
    runtime,
    setDefaultModel: false,
    opts: apiKey && catalogEntry.optionKey ? { [catalogEntry.optionKey]: apiKey } : undefined,
  });
  // The apply flow can return success-shaped results without usable auth
  // (cancelled retrySelection, disabled/unresolvable plugin). Revalidate
  // before persisting so a claim never registers models the user cannot run.
  const authCompleted =
    applied &&
    !applied.retrySelection &&
    (await hasAvailableAuthForProvider({ provider, cfg: applied.config }));
  if (!applied || !authCompleted) {
    throw new Error(`Authentication for "${provider}" was not completed; nothing was changed.`);
  }
  await replaceConfigFile({ nextConfig: applied.config, baseHash: snapshot.hash });
}

function aliasTaken(models: Record<string, AgentModelEntryConfig>, alias: string): boolean {
  const lowered = alias.toLowerCase();
  return Object.values(models).some((entry) => entry.alias?.toLowerCase() === lowered);
}

export async function promosClaimCommand(
  slugRaw: string,
  opts: PromosClaimOptions,
  runtime: RuntimeEnv,
) {
  const slug = slugRaw.trim().toLowerCase();
  if (!slug) {
    throw new Error("Promotion slug required.");
  }
  const promotion = await fetchLivePromotion(slug);
  requireLiveWindow(promotion);

  const provider = promotion.provider?.trim();
  if (!provider) {
    throw new Error(
      `Promotion "${slug}" does not declare a provider; it cannot be claimed from the CLI.`,
    );
  }
  // Validate the declarative payload against the local catalog before any action.
  for (const model of promotion.models) {
    resolvePromotionModelTarget(promotion, model.modelRef);
  }
  const snapshot = await readValidConfigSnapshot();
  const catalogEntry = resolveAuthChoice(
    promotion,
    provider,
    snapshot.runtimeConfig ?? snapshot.config,
  );

  await ensureProviderAuth({ promotion, provider, catalogEntry, snapshot, opts, runtime });

  const suggested = promotion.models.find((model) => model.suggestedDefault) ?? promotion.models[0];
  let makeDefault = Boolean(opts.setDefault && suggested);
  if (!makeDefault && suggested && process.stdin.isTTY) {
    makeDefault = await promptYesNo(`Set ${suggested.modelRef} as your default model?`, false);
  }

  const registered: string[] = [];
  const skippedAliases: string[] = [];
  await updateConfig((cfg, context) => {
    const models = {
      ...cfg.agents?.defaults?.models,
    } as Record<string, AgentModelEntryConfig>;
    for (const model of promotion.models) {
      const target = resolvePromotionModelTarget(promotion, model.modelRef);
      const key = upsertCanonicalModelConfigEntry(models, target);
      // Aliases are remote text persisted into config and rendered by other
      // CLI surfaces; hold them to the same contract as `models aliases add`.
      let alias: string | undefined;
      try {
        alias = model.alias ? normalizeAlias(model.alias) : undefined;
      } catch {
        skippedAliases.push(model.alias ?? "");
      }
      if (alias && !models[key]?.alias) {
        if (aliasTaken(models, alias)) {
          skippedAliases.push(alias);
        } else {
          models[key] = { ...models[key], alias };
        }
      }
      registered.push(key);
    }
    let next: OpenClawConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models,
        },
      },
    };
    if (makeDefault && suggested) {
      next = applyDefaultModelPrimaryUpdate({
        cfg: next,
        resolveCfg: context.runtimeConfig,
        modelRaw: suggested.modelRef,
        field: "model",
      });
    }
    return next;
  });

  runtime.log(`Claimed "${sanitizeTerminalText(promotion.title)}".`);
  for (const key of registered) {
    runtime.log(`  Added model: ${sanitizeTerminalText(key)}`);
  }
  for (const alias of skippedAliases) {
    runtime.log(
      `  Alias "${sanitizeTerminalText(alias)}" is already in use; kept your existing alias.`,
    );
  }
  if (makeDefault && suggested) {
    runtime.log(`  Default model set to ${sanitizeTerminalText(suggested.modelRef)}.`);
    runtime.log(
      `  Revert anytime with ${formatCliCommand("openclaw models set <previous-model>")}.`,
    );
  } else if (suggested) {
    runtime.log(
      `  Try it: ${formatCliCommand(`openclaw models set ${suggested.modelRef}`)} (promotion ends ${new Date(promotion.endsAt).toLocaleDateString()}).`,
    );
  }
}
