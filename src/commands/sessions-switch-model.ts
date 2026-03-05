import { parseModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { resolveConfiguredEntries } from "./models/list.configured.js";
import { DEFAULT_PROVIDER, modelKey } from "./models/shared.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

export type SessionsSwitchModelOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  all?: boolean;
  slackChannel?: string;
  dryRun?: boolean;
  yes?: boolean;
  providerModel: string;
};

type SwitchCandidate = {
  key: string;
  storePath: string;
  currentProvider: string;
  currentModel: string;
};

function parseRequiredProviderModel(raw: string): { provider: string; model: string } | null {
  if (!raw.includes("/")) {
    return null;
  }
  const parsed = parseModelRef(raw, DEFAULT_PROVIDER);
  if (!parsed || !parsed.provider || !parsed.model) {
    return null;
  }
  return parsed;
}

function normalizeSlackChannel(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^#/, "").toLowerCase();
}

function matchesSlackChannel(entry: SessionEntry, channel: string): boolean {
  const groupChannel = String(entry.groupChannel ?? "").trim();
  if (!groupChannel) {
    return false;
  }
  return normalizeSlackChannel(groupChannel) === channel;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value.padEnd(width);
}

function validateFilterOptions(
  opts: { all?: boolean; slackChannel?: string },
  runtime: RuntimeEnv,
) {
  const hasAll = opts.all === true;
  const slack = opts.slackChannel?.trim();
  const hasSlack = Boolean(slack);
  if (hasAll === hasSlack) {
    runtime.error("Specify exactly one filter: --all or --slack-channel <name>.");
    runtime.exit(1);
    return null;
  }
  return { hasAll, slackChannel: hasSlack ? normalizeSlackChannel(slack ?? "") : undefined };
}

function validateTargetModel(
  cfg: ReturnType<typeof loadConfig>,
  raw: string,
  runtime: RuntimeEnv,
): { provider: string; model: string } | null {
  const parsed = parseRequiredProviderModel(raw);
  if (!parsed) {
    runtime.error('Model must be in "provider/model" format.');
    runtime.exit(1);
    return null;
  }
  const allowed = new Set(resolveConfiguredEntries(cfg).entries.map((entry) => entry.key));
  const key = modelKey(parsed.provider, parsed.model);
  if (!allowed.has(key)) {
    runtime.error(`Model "${key}" not found in "openclaw models list --plain".`);
    runtime.exit(1);
    return null;
  }
  return parsed;
}

export async function sessionsSwitchModelCommand(
  opts: SessionsSwitchModelOptions,
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const filter = validateFilterOptions(
    {
      all: opts.all,
      slackChannel: opts.slackChannel,
    },
    runtime,
  );
  if (!filter) {
    return;
  }
  const targetModel = validateTargetModel(cfg, opts.providerModel, runtime);
  if (!targetModel) {
    return;
  }
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  const matched: SwitchCandidate[] = [];
  for (const target of targets) {
    const store = loadSessionStore(target.storePath);
    for (const [key, entry] of Object.entries(store)) {
      if (!entry) {
        continue;
      }
      const include = filter.hasAll ? true : matchesSlackChannel(entry, filter.slackChannel ?? "");
      if (!include) {
        continue;
      }
      matched.push({
        key,
        storePath: target.storePath,
        currentProvider: String(entry.modelProvider ?? "?"),
        currentModel: String(entry.model ?? "?"),
      });
    }
  }

  if (matched.length === 0) {
    runtime.log("No matching sessions found.");
    return;
  }

  const nextLabel = `${targetModel.provider}/${targetModel.model}`;
  const prefix = opts.dryRun ? "[DRY RUN] " : "";
  runtime.log(
    `${prefix}Switching ${matched.length} session(s) to provider=${targetModel.provider} model=${targetModel.model}`,
  );
  runtime.log("");
  runtime.log(`${pad("Key", 60)} ${pad("Current model", 30)} -> New`);
  runtime.log("-".repeat(108));

  for (const candidate of matched.toSorted((a, b) => a.key.localeCompare(b.key))) {
    const oldLabel = `${candidate.currentProvider}/${candidate.currentModel}`;
    const unchanged = oldLabel === nextLabel ? " (no change)" : "";
    runtime.log(`${pad(candidate.key, 60)} ${pad(oldLabel, 30)} -> ${nextLabel}${unchanged}`);
  }

  const toChange = matched.filter(
    (candidate) =>
      candidate.currentProvider !== targetModel.provider ||
      candidate.currentModel !== targetModel.model,
  );

  if (toChange.length === 0) {
    runtime.log("");
    runtime.log("All matched sessions already use this model.");
    return;
  }

  runtime.log("");
  runtime.log(`${toChange.length} session(s) will be updated.`);

  if (opts.dryRun) {
    runtime.log("");
    runtime.log("Dry run - no changes applied.");
    return;
  }

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      runtime.error("Non-interactive session. Re-run with --yes.");
      runtime.exit(1);
      return;
    }
    const prompter = createClackPrompter();
    const ok = await prompter.confirm({
      message: "Apply changes?",
      initialValue: false,
    });
    if (!ok) {
      runtime.log("Aborted.");
      return;
    }
  }

  const changesByStore = new Map<string, Set<string>>();
  for (const candidate of toChange) {
    const keys = changesByStore.get(candidate.storePath) ?? new Set<string>();
    keys.add(candidate.key);
    changesByStore.set(candidate.storePath, keys);
  }

  for (const [storePath, keys] of changesByStore.entries()) {
    await updateSessionStore(storePath, (store) => {
      for (const key of keys) {
        const entry = store[key];
        if (!entry) {
          continue;
        }
        entry.modelProvider = targetModel.provider;
        entry.model = targetModel.model;
      }
    });
  }

  runtime.log("");
  runtime.log(`Done - updated ${toChange.length} session(s).`);
}
