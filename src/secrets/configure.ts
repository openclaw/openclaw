import { confirm, select, text } from "@clack/prompts";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretRef, SecretRefSource } from "../config/types.secrets.js";
import { runSecretsApply, type SecretsApplyResult } from "./apply.js";
import { createSecretsConfigIO } from "./config-io.js";
import { type SecretsApplyPlan } from "./plan.js";
import { resolveDefaultSecretProviderAlias } from "./ref-contract.js";
import { isRecord } from "./shared.js";

type ConfigureCandidate = {
  type: "models.providers.apiKey" | "skills.entries.apiKey" | "channels.googlechat.serviceAccount";
  path: string;
  label: string;
  providerId?: string;
  accountId?: string;
};

export type SecretsConfigureResult = {
  plan: SecretsApplyPlan;
  preflight: SecretsApplyResult;
};

function buildCandidates(config: OpenClawConfig): ConfigureCandidate[] {
  const out: ConfigureCandidate[] = [];
  const providers = config.models?.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const [providerId, providerValue] of Object.entries(providers)) {
      if (!isRecord(providerValue)) {
        continue;
      }
      out.push({
        type: "models.providers.apiKey",
        path: `models.providers.${providerId}.apiKey`,
        label: `Provider API key: ${providerId}`,
        providerId,
      });
    }
  }

  const entries = config.skills?.entries as Record<string, unknown> | undefined;
  if (entries) {
    for (const [entryId, entryValue] of Object.entries(entries)) {
      if (!isRecord(entryValue)) {
        continue;
      }
      out.push({
        type: "skills.entries.apiKey",
        path: `skills.entries.${entryId}.apiKey`,
        label: `Skill API key: ${entryId}`,
      });
    }
  }

  const googlechat = config.channels?.googlechat;
  if (isRecord(googlechat)) {
    out.push({
      type: "channels.googlechat.serviceAccount",
      path: "channels.googlechat.serviceAccount",
      label: "Google Chat serviceAccount (default)",
    });
    const accounts = googlechat.accounts;
    if (isRecord(accounts)) {
      for (const [accountId, value] of Object.entries(accounts)) {
        if (!isRecord(value)) {
          continue;
        }
        out.push({
          type: "channels.googlechat.serviceAccount",
          path: `channels.googlechat.accounts.${accountId}.serviceAccount`,
          label: `Google Chat serviceAccount (${accountId})`,
          accountId,
        });
      }
    }
  }

  return out;
}

function toSourceChoices(config: OpenClawConfig): Array<{ value: SecretRefSource; label: string }> {
  const hasSource = (source: SecretRefSource) =>
    Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
  const choices: Array<{ value: SecretRefSource; label: string }> = [
    { value: "env", label: "env" },
  ];
  if (hasSource("file")) {
    choices.push({ value: "file", label: "file" });
  }
  if (hasSource("exec")) {
    choices.push({ value: "exec", label: "exec" });
  }
  return choices;
}

function assertNoCancel<T>(value: T | symbol, message: string): T {
  if (typeof value === "symbol") {
    throw new Error(message);
  }
  return value;
}

export async function runSecretsConfigureInteractive(
  params: {
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SecretsConfigureResult> {
  if (!process.stdin.isTTY) {
    throw new Error("secrets configure requires an interactive TTY.");
  }
  const env = params.env ?? process.env;
  const io = createSecretsConfigIO({ env });
  const { snapshot } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot run interactive secrets configure because config is invalid.");
  }

  const candidates = buildCandidates(snapshot.config);
  if (candidates.length === 0) {
    throw new Error("No configurable secret-bearing fields found in openclaw.json.");
  }

  const selectedByPath = new Map<string, ConfigureCandidate & { ref: SecretRef }>();
  const sourceChoices = toSourceChoices(snapshot.config);

  while (true) {
    const options = candidates.map((candidate) => ({
      value: candidate.path,
      label: candidate.label,
      hint: candidate.path,
    }));
    if (selectedByPath.size > 0) {
      options.unshift({
        value: "__done__",
        label: "Done",
        hint: "Finish and run preflight",
      });
    }

    const selectedPath = assertNoCancel(
      await select({
        message: "Select credential field",
        options,
      }),
      "Secrets configure cancelled.",
    );

    if (selectedPath === "__done__") {
      break;
    }

    const candidate = candidates.find((entry) => entry.path === selectedPath);
    if (!candidate) {
      throw new Error(`Unknown configure target: ${selectedPath}`);
    }

    const source = assertNoCancel(
      await select({
        message: "Secret source",
        options: sourceChoices,
      }),
      "Secrets configure cancelled.",
    ) as SecretRefSource;

    const defaultAlias = resolveDefaultSecretProviderAlias(snapshot.config, source, {
      preferFirstProviderForSource: true,
    });
    const provider = assertNoCancel(
      await text({
        message: "Provider alias",
        initialValue: defaultAlias,
        validate: (value) => (String(value ?? "").trim().length > 0 ? undefined : "Required"),
      }),
      "Secrets configure cancelled.",
    );
    const id = assertNoCancel(
      await text({
        message: "Secret id",
        validate: (value) => (String(value ?? "").trim().length > 0 ? undefined : "Required"),
      }),
      "Secrets configure cancelled.",
    );
    const ref: SecretRef = {
      source,
      provider: String(provider).trim(),
      id: String(id).trim(),
    };

    const next = {
      ...candidate,
      ref,
    };
    selectedByPath.set(candidate.path, next);

    const addMore = assertNoCancel(
      await confirm({
        message: "Configure another credential?",
        initialValue: true,
      }),
      "Secrets configure cancelled.",
    );
    if (!addMore) {
      break;
    }
  }

  if (selectedByPath.size === 0) {
    throw new Error("No secrets were selected.");
  }

  const plan: SecretsApplyPlan = {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "openclaw secrets configure",
    targets: [...selectedByPath.values()].map((entry) => ({
      type: entry.type,
      path: entry.path,
      ref: entry.ref,
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
    })),
    options: {
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: true,
    },
  };

  const preflight = await runSecretsApply({
    plan,
    env,
    write: false,
  });

  return { plan, preflight };
}
