import { cancel, confirm, isCancel, log } from "@clack/prompts";
import {
  stylePromptHint,
  stylePromptMessage,
  stylePromptTitle,
} from "../../packages/terminal-core/src/prompt-style.js";
import { formatCliCommand } from "../cli/command-format.js";
import { withProgress } from "../cli/progress.js";
import { promptYesNo } from "../cli/prompt.js";
import { getRuntimeConfig } from "../config/config.js";
import { redactMigrationPlan, summarizeMigrationItems } from "../plugin-sdk/migration.js";
import { withPluginMigrationProviders } from "../plugins/migration-provider-runtime.js";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { runMigrationApply } from "./migrate/apply.js";
import { formatMigrationPreview } from "./migrate/output.js";
import { createMigrationPlan, withMigrationProvider } from "./migrate/providers.js";
import {
  applyMigrationSelectedItemIds,
  applyMigrationSelections,
  formatMigrationSelectionHint,
  formatMigrationSelectionLabel,
  getDefaultMigrationSelectionValues,
  getSelectableMigrationItems,
  MIGRATION_SELECTION_ACCEPT,
  MIGRATION_SELECTION_TOGGLE_ALL_OFF,
  MIGRATION_SELECTION_TOGGLE_ALL_ON,
  resolveInteractiveMigrationSelection,
} from "./migrate/selection.js";
import { promptMigrationSkillSelectionValues } from "./migrate/skill-selection-prompt.js";
import type {
  MigrateApplyOptions,
  MigrateCommonOptions,
  MigrateDefaultOptions,
} from "./migrate/types.js";

function hasPlannedAuthCredentialItem(plan: MigrationPlan): boolean {
  return plan.items.some(
    (item) =>
      item.status === "planned" &&
      (item.kind === "auth" || item.kind === "secret" || item.sensitive === true),
  );
}

function resolveDefaultIncludeSecrets<T extends MigrateCommonOptions>(opts: T): T {
  if (opts.authCredentials === false) {
    return { ...opts, includeSecrets: false };
  }
  return opts;
}

function shouldPromptForAuthCredentials(opts: MigrateCommonOptions & { yes?: boolean }): boolean {
  return (
    opts.includeSecrets === undefined &&
    opts.authCredentials !== false &&
    !opts.yes &&
    !opts.json &&
    process.stdin.isTTY
  );
}

async function createInteractiveMigrationPlanWithAuthPrompt(
  runtime: RuntimeEnv,
  opts: MigrateCommonOptions & { provider: string; yes?: boolean },
  provider: MigrationProviderPlugin,
): Promise<MigrationPlan> {
  if (!shouldPromptForAuthCredentials(opts)) {
    return await migratePlanCommand(runtime, resolveDefaultIncludeSecrets(opts), provider);
  }
  let plan = await migratePlanCommand(
    runtime,
    {
      ...opts,
      includeSecrets: false,
      suppressPlanLog: true,
    },
    provider,
  );
  if (
    plan.items.some(
      (item) => item.kind === "auth" || item.kind === "secret" || item.sensitive === true,
    )
  ) {
    // Rescan with secrets only after explicit consent.
    const includeSecrets = await confirm({
      message: stylePromptMessage("Do you want to migrate your auth credentials as well?"),
      initialValue: true,
    });
    if (isCancel(includeSecrets)) {
      cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
      runtime.exit(0);
      throw new Error("unreachable");
    }
    if (includeSecrets) {
      plan = await migratePlanCommand(
        runtime,
        {
          ...opts,
          includeSecrets: true,
          suppressPlanLog: true,
        },
        provider,
      );
    }
  }
  if (!opts.suppressPlanLog) {
    log.message(formatMigrationPreview(plan).join("\n"));
  }
  return plan;
}

function assertVerifyPluginAppsProvider(providerId: string, opts: MigrateCommonOptions): void {
  if (opts.verifyPluginApps && providerId !== "codex") {
    throw new Error("--verify-plugin-apps is only supported for Codex migrations.");
  }
}

async function promptCodexMigrationSelection(
  runtime: RuntimeEnv,
  plan: MigrationPlan,
  opts: MigrateCommonOptions & { yes?: boolean },
  kind: "skills" | "plugins",
): Promise<MigrationPlan | null> {
  if (
    plan.providerId !== "codex" ||
    opts.yes ||
    opts.json ||
    opts[kind] !== undefined ||
    !process.stdin.isTTY
  ) {
    return plan;
  }
  const skillSelection = kind === "skills";
  const itemKind = skillSelection ? "skill" : "plugin";
  const items = getSelectableMigrationItems(plan, itemKind);
  if (items.length === 0) {
    return plan;
  }
  const selected = await promptMigrationSkillSelectionValues({
    message: stylePromptMessage(
      skillSelection
        ? "Select Codex skills to migrate into this agent"
        : "Select native Codex plugins to activate in this agent",
    ),
    options: [
      {
        value: MIGRATION_SELECTION_ACCEPT,
        label: "Accept recommended",
        hint: skillSelection
          ? "Migrate every recommended skill"
          : "Migrate every recommended plugin",
      },
      ...items.map((item) => {
        const hint = formatMigrationSelectionHint(item, itemKind);
        return {
          value: item.id,
          label: formatMigrationSelectionLabel(item, itemKind),
          hint: hint === undefined ? undefined : stylePromptHint(hint),
        };
      }),
      {
        value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
        label: "Toggle all on",
      },
      {
        value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
        label: "Toggle all off",
      },
    ],
    initialValues: getDefaultMigrationSelectionValues(items),
    selectableValues: items.map((item) => item.id),
    cursorAt: MIGRATION_SELECTION_ACCEPT,
  });
  if (typeof selected === "symbol") {
    cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
    runtime.log("Migration cancelled.");
    return null;
  }
  const selection = resolveInteractiveMigrationSelection(items, selected ?? []);
  const selectedPlan = applyMigrationSelectedItemIds(plan, selection, itemKind);
  const purpose = skillSelection
    ? "Codex skills for migration"
    : "native Codex plugins for activation";
  runtime.log(`Selected ${selection.size} of ${items.length} ${purpose}.`);
  return selectedPlan;
}

async function confirmInteractiveMigrationPlan(
  runtime: RuntimeEnv,
  plan: MigrationPlan,
  opts: MigrateApplyOptions,
): Promise<{ plan: MigrationPlan; applyOpts?: MigrateApplyOptions }> {
  const skillSelectedPlan = await promptCodexMigrationSelection(runtime, plan, opts, "skills");
  const selectedPlan =
    skillSelectedPlan &&
    (await promptCodexMigrationSelection(runtime, skillSelectedPlan, opts, "plugins"));
  if (!selectedPlan) {
    return { plan };
  }
  if (selectedPlan.providerId === "codex" && !hasSelectedCodexMigrationWork(selectedPlan)) {
    logNoCodexSelection(runtime, selectedPlan);
    return { plan: selectedPlan };
  }
  const apply = await promptYesNo("Apply this migration now?", false);
  if (!apply) {
    runtime.log("Migration cancelled.");
    return { plan: selectedPlan };
  }
  return {
    plan: selectedPlan,
    applyOpts: {
      ...opts,
      yes: true,
      includeSecrets: opts.includeSecrets ?? hasPlannedAuthCredentialItem(selectedPlan),
      preflightPlan: selectedPlan,
    },
  };
}

function hasSelectedCodexMigrationWork(plan: MigrationPlan): boolean {
  return plan.items.some(
    (item) =>
      item.status === "planned" &&
      (item.kind === "auth" ||
        item.kind === "secret" ||
        (item.kind === "skill" && item.action === "copy") ||
        (item.kind === "plugin" && item.action === "install")),
  );
}

function logNoCodexSelection(runtime: RuntimeEnv, plan: MigrationPlan): void {
  if (
    plan.providerId === "codex" &&
    plan.items.some((item) => item.reason === "codex_subscription_required")
  ) {
    const warning = plan.warnings?.find((entry) =>
      entry.includes("Codex app-backed plugin migration requires"),
    );
    if (warning) {
      runtime.log(warning);
    }
    runtime.log(
      "No Codex skills selected; native Codex plugins are not eligible for migration in this run.",
    );
    return;
  }
  runtime.log("No Codex skills or native Codex plugins selected for migration.");
}

/** Lists available migration providers as JSON or terse terminal rows. */
export async function migrateListCommand(runtime: RuntimeEnv, opts: { json?: boolean } = {}) {
  const cfg = getRuntimeConfig();
  return await withPluginMigrationProviders({ cfg }, async (registered) => {
    const providers = registered.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
    }));
    if (opts.json) {
      writeRuntimeJson(runtime, { providers });
      return;
    }
    if (providers.length === 0) {
      runtime.log(
        `No migration providers found. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed and enabled.`,
      );
      return;
    }
    runtime.log(
      providers
        .map((provider) =>
          provider.description
            ? `${provider.id}\t${provider.label} - ${provider.description}`
            : `${provider.id}\t${provider.label}`,
        )
        .join("\n"),
    );
  });
}

/** Creates and prints a migration plan without applying it. */
export async function migratePlanCommand(
  runtime: RuntimeEnv,
  opts: MigrateCommonOptions,
  provider?: MigrationProviderPlugin,
): Promise<MigrationPlan> {
  const providerId = opts.provider?.trim();
  if (!providerId) {
    throw new Error(
      `Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`,
    );
  }
  const resolvedOpts = resolveDefaultIncludeSecrets(opts);
  assertVerifyPluginAppsProvider(providerId, resolvedOpts);
  if (!provider) {
    return await withMigrationProvider(
      providerId,
      opts.configOverride,
      async (owned) => await migratePlanCommand(runtime, opts, owned),
    );
  }
  const createPlan = () =>
    createMigrationPlan(runtime, { ...resolvedOpts, provider: providerId }, provider);
  const plan = applyMigrationSelections(
    resolvedOpts.json
      ? await createPlan()
      : await withProgress(
          { label: `Scanning ${providerId} migration…`, indeterminate: true },
          async (progress) => {
            progress.setLabel("Reading migration source…");
            const scanned = await createPlan();
            progress.tick();
            return scanned;
          },
        ),
    resolvedOpts,
  );
  if (resolvedOpts.json) {
    writeRuntimeJson(runtime, redactMigrationPlan(plan));
  } else if (resolvedOpts.suppressPlanLog !== true) {
    log.message(formatMigrationPreview(plan).join("\n"));
  }
  return plan;
}

/** Applies a migration non-interactively when `yes` is true. */
export async function migrateApplyCommand(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions & { yes: true },
  provider?: MigrationProviderPlugin,
): Promise<MigrationApplyResult>;
/** Plans interactively when needed, prompts, then applies the selected migration. */
export async function migrateApplyCommand(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions,
  provider?: MigrationProviderPlugin,
): Promise<MigrationApplyResult | MigrationPlan>;
export async function migrateApplyCommand(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions,
  provider?: MigrationProviderPlugin,
): Promise<MigrationApplyResult | MigrationPlan> {
  const providerId = opts.provider?.trim();
  if (!providerId) {
    throw new Error(
      `Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`,
    );
  }
  assertVerifyPluginAppsProvider(providerId, opts);
  if (opts.noBackup && !opts.force) {
    throw new Error("--no-backup requires --force because it skips the automatic rollback copy.");
  }
  if (!opts.yes && !process.stdin.isTTY) {
    throw new Error(
      `openclaw migrate apply requires --yes in non-interactive mode. Preview first with ${formatCliCommand(`openclaw migrate plan '${providerId.replaceAll("'", "'\\''")}'`)}.`,
    );
  }
  if (!provider) {
    return await withMigrationProvider(
      providerId,
      opts.configOverride,
      async (owned) => await migrateApplyCommand(runtime, opts, owned),
    );
  }
  let applyOpts = resolveDefaultIncludeSecrets(opts);
  if (!opts.yes) {
    const plan = await createInteractiveMigrationPlanWithAuthPrompt(
      runtime,
      {
        ...opts,
        provider: providerId,
        json: opts.json,
      },
      provider,
    );
    if (opts.json) {
      return plan;
    }
    const confirmed = await confirmInteractiveMigrationPlan(runtime, plan, opts);
    if (!confirmed.applyOpts) {
      return confirmed.plan;
    }
    applyOpts = { ...confirmed.applyOpts, provider: providerId };
  }
  return await runMigrationApply({
    runtime,
    opts: applyOpts,
    providerId,
    provider,
  });
}

/** Default migrate command: list providers, plan, dry-run, or apply based on flags. */
export async function migrateDefaultCommand(
  runtime: RuntimeEnv,
  opts: MigrateDefaultOptions,
  provider?: MigrationProviderPlugin,
): Promise<MigrationPlan | MigrationApplyResult> {
  const providerId = opts.provider?.trim();
  if (!providerId) {
    await migrateListCommand(runtime, { json: opts.json });
    return {
      providerId: "list",
      source: "",
      summary: summarizeMigrationItems([]),
      items: [],
    };
  }
  assertVerifyPluginAppsProvider(providerId, opts);
  if (!provider) {
    return await withMigrationProvider(
      providerId,
      opts.configOverride,
      async (owned) => await migrateDefaultCommand(runtime, opts, owned),
    );
  }
  const resolvedOpts = resolveDefaultIncludeSecrets(opts);
  const planOpts = {
    ...opts,
    provider: providerId,
    json: opts.json && (opts.dryRun || !opts.yes),
  };
  let plan =
    opts.json && opts.yes && !opts.dryRun
      ? applyMigrationSelections(
          await createMigrationPlan(runtime, { ...resolvedOpts, provider: providerId }, provider),
          resolvedOpts,
        )
      : !opts.yes && process.stdin.isTTY
        ? await createInteractiveMigrationPlanWithAuthPrompt(runtime, planOpts, provider)
        : await migratePlanCommand(runtime, resolveDefaultIncludeSecrets(planOpts), provider);
  if (opts.dryRun || (opts.json && !opts.yes)) {
    return plan;
  }
  let applyOpts = resolvedOpts;
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      runtime.log("Re-run with --yes to apply this migration non-interactively.");
      return plan;
    }
    const confirmed = await confirmInteractiveMigrationPlan(runtime, plan, opts);
    if (!confirmed.applyOpts) {
      return confirmed.plan;
    }
    plan = confirmed.plan;
    applyOpts = confirmed.applyOpts;
  }
  return await migrateApplyCommand(
    runtime,
    {
      ...applyOpts,
      provider: providerId,
      yes: true,
      json: opts.json,
      preflightPlan: plan,
    },
    provider,
  );
}
