import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
} from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchClawHubSkillVerification } from "../infra/clawhub-skills.js";
import { formatErrorMessage } from "../infra/errors.js";
import { scanInstalledApps } from "../infra/installed-apps.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  installSkillFromClawHub,
  resolveClawHubSkillVerificationTarget,
} from "../skills/lifecycle/clawhub.js";
import { createOnboardingRecommendationsStore } from "../state/onboarding-recommendations.js";
import {
  getSetupAppRecommendations,
  type SetupAppRecommendationMatch,
  type SetupAppRecommendationsResult,
  type SetupAppScanPhase,
} from "../system-agent/setup-app-recommendations.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

const SKIP_VALUE = "__skip__";

async function isClawHubSkillInstalled(params: {
  workspaceDir: string;
  skillRef: string;
}): Promise<boolean> {
  const target = await resolveClawHubSkillVerificationTarget({
    workspaceDir: params.workspaceDir,
    slug: params.skillRef,
  });
  if (!target.ok || target.resolution.source !== "installed") {
    return false;
  }
  const verification = await fetchClawHubSkillVerification({
    slug: target.slug,
    ...(target.ownerHandle ? { ownerHandle: target.ownerHandle } : {}),
    version: target.version,
    baseUrl: target.baseUrl,
  });
  return verification.ok && verification.decision === "pass";
}

export type SetupAppRecommendationsOutcome = {
  config: OpenClawConfig;
  commitResult: () => Promise<void>;
};

function unchangedOutcome(config: OpenClawConfig): SetupAppRecommendationsOutcome {
  return { config, commitResult: async () => undefined };
}

function resolveOfficialEntry(pluginId: string): OnboardingPluginInstallEntry | undefined {
  const catalogEntry = listOfficialExternalPluginCatalogEntries().find(
    (entry) => resolveOfficialExternalPluginId(entry) === pluginId,
  );
  const install = catalogEntry ? resolveOfficialExternalPluginInstall(catalogEntry) : undefined;
  if (!catalogEntry || !install) {
    return undefined;
  }
  return {
    pluginId,
    label: resolveOfficialExternalPluginLabel(catalogEntry),
    install,
    trustedSourceLinkedOfficialInstall: true,
  };
}

function selectionValue(index: number): string {
  return `recommendation:${index}`;
}

function uniqueSelectedMatches(
  matches: SetupAppRecommendationMatch[],
  selected: string[],
): SetupAppRecommendationMatch[] {
  const selectedValues = new Set(selected);
  const seen = new Set<string>();
  return matches.filter((match, index) => {
    const key = `${match.candidate.source}:${match.candidate.id}`;
    if (!selectedValues.has(selectionValue(index)) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function setupAppRecommendations(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  modelRouteVerified: boolean;
}): Promise<SetupAppRecommendationsOutcome> {
  // Product decision: default-on "magical" scan with a kill switch, not
  // consent-first. App labels/bundle ids go to the user's configured model and
  // ClawHub search; a static disclosure stays in scrollback before app names
  // leave the machine, while results repeat it. The config flag disables the step.
  if (
    params.config.wizard?.appRecommendations === false ||
    process.platform !== "darwin" ||
    !params.modelRouteVerified
  ) {
    return unchangedOutcome(params.config);
  }
  const store = createOnboardingRecommendationsStore({ workspaceDir: params.workspaceDir });
  const storedRecord = await store.read();
  if (typeof storedRecord?.acceptedAt === "number") {
    return unchangedOutcome(params.config);
  }
  // Pending recommendations are rebuildable cache. Rescan legacy bare
  // ClawHub ids instead of installing without a publisher identity.
  const hasLegacyClawHubId = storedRecord?.matches.some(
    (match) => match.candidate.source === "clawhub-skill" && !match.candidate.id.startsWith("@"),
  );
  if (hasLegacyClawHubId && storedRecord) {
    if (!(await store.clearPending({ expected: storedRecord }))) {
      return unchangedOutcome(params.config);
    }
  }
  const stored = hasLegacyClawHubId ? null : storedRecord;
  const deferOfferToBootstrap = () =>
    existsSync(path.join(params.workspaceDir, DEFAULT_BOOTSTRAP_FILENAME));

  // A pending stored offer means a completed scan's app labels already left
  // the machine once; never rescan or re-query the model for it. Either the
  // bootstrap still owns the ask, or the wizard presents the stored matches.
  let matches: SetupAppRecommendationMatch[];
  let appLabels: string[];
  let pendingRecord = stored;
  let recordResult: (retryMatches: SetupAppRecommendationMatch[]) => Promise<void>;
  const commitStoredResult = async (retryMatches: SetupAppRecommendationMatch[]) => {
    if (!pendingRecord) {
      throw new Error("Stored onboarding recommendations changed while setup was running.");
    }
    const expected = pendingRecord;
    const updated =
      retryMatches.length === 0
        ? await store.acknowledge({ expected })
        : await store.updatePending({ matches: retryMatches, expected });
    if (!updated) {
      throw new Error("Stored onboarding recommendations changed while setup was running.");
    }
    pendingRecord = updated;
  };
  if (stored) {
    if (deferOfferToBootstrap()) {
      return unchangedOutcome(params.config);
    }
    matches = stored.matches;
    appLabels = [...new Set(stored.matches.map((match) => match.appLabel))];
    recordResult = commitStoredResult;
  } else {
    const scanDisclosure = t("wizard.appRecommendations.scanDisclosure");
    // Gateway wizards must show the disclosure on the client before app names
    // leave the machine; CLI plain output preserves the same ordering locally.
    if (params.prompter.plain) {
      await params.prompter.plain(scanDisclosure);
    } else {
      params.runtime.log(scanDisclosure);
    }
    const progress = params.prompter.progress(t("wizard.appRecommendations.scanning"));
    const scanPhaseMessage = (phase: SetupAppScanPhase): string => {
      if (phase.kind === "candidates") {
        return t(
          phase.appCount === 1
            ? "wizard.appRecommendations.scanningCandidate"
            : "wizard.appRecommendations.scanningCandidates",
          { count: phase.appCount, sample: phase.sampleLabels.join(", ") },
        );
      }
      return t("wizard.appRecommendations.scanningMatch");
    };
    const onPhase = (phase: SetupAppScanPhase) => progress.update(scanPhaseMessage(phase));
    let result: SetupAppRecommendationsResult;
    try {
      result = await getSetupAppRecommendations({
        inventorySource: async () => await scanInstalledApps(),
        runtime: params.runtime,
        onPhase,
      });
    } catch (error) {
      progress.stop();
      params.runtime.log(
        t("wizard.appRecommendations.skipped", { reason: formatErrorMessage(error) }),
      );
      return unchangedOutcome(params.config);
    }
    progress.stop();
    if (result.status !== "ok") {
      params.runtime.log(t("wizard.appRecommendations.noneFound"));
      return unchangedOutcome(params.config);
    }
    if (deferOfferToBootstrap()) {
      await store.writeOffer({ inventory: result.apps, matches: result.matches, answered: false });
      return unchangedOutcome(params.config);
    }
    const scanned = result;
    matches = scanned.matches;
    appLabels = scanned.apps.map((app) => app.label);
    recordResult = async (retryMatches) => {
      if (!pendingRecord) {
        pendingRecord = await store.writeOffer({
          inventory: scanned.apps,
          matches: retryMatches.length > 0 ? retryMatches : scanned.matches,
          answered: retryMatches.length === 0,
        });
        return;
      }
      await commitStoredResult(retryMatches);
    };
  }

  await params.prompter.note(
    [
      t("wizard.appRecommendations.detected", { apps: appLabels.join(", ") }),
      t("wizard.appRecommendations.disclosure"),
    ].join("\n"),
    t("wizard.appRecommendations.title"),
  );
  const selected = await params.prompter.multiselect({
    message: t("wizard.appRecommendations.select"),
    options: [
      { value: SKIP_VALUE, label: t("common.skipForNow") },
      ...matches.map((match, index) => ({
        value: selectionValue(index),
        label: t(
          match.candidate.source === "clawhub-skill"
            ? "wizard.appRecommendations.optionThirdParty"
            : "wizard.appRecommendations.option",
          {
            name: match.candidate.displayName,
            reason: match.reason,
            app: match.appLabel,
          },
        ),
      })),
    ],
    // Supply-chain guard: ClawHub listing text is publisher-controlled and
    // reaches the matcher prompt, so a listing can promote itself to
    // "recommended". Only official catalog entries may be pre-selected;
    // third-party skills always require an explicit opt-in tick.
    initialValues: matches.flatMap((match, index) =>
      match.tier === "recommended" && match.candidate.source !== "clawhub-skill"
        ? [selectionValue(index)]
        : [],
    ),
  });
  let next = params.config;
  const selectedMatches = selected.includes(SKIP_VALUE)
    ? []
    : uniqueSelectedMatches(matches, selected);
  if (selectedMatches.length === 0) {
    await recordResult([]);
    return unchangedOutcome(params.config);
  }
  // Persist the selected set before external installs. Unselected matches are
  // explicit declines; selected matches stay retryable until each install succeeds.
  await recordResult(selectedMatches);
  let pendingMatches = selectedMatches;
  const retryMatches: SetupAppRecommendationMatch[] = [];
  for (const match of selectedMatches) {
    let installed = false;
    try {
      if (match.candidate.source === "clawhub-skill") {
        const alreadyInstalled = await isClawHubSkillInstalled({
          workspaceDir: params.workspaceDir,
          skillRef: match.candidate.id,
        });
        if (!alreadyInstalled) {
          const result = await installSkillFromClawHub({
            workspaceDir: params.workspaceDir,
            slug: match.candidate.id,
            config: next,
            logger: { warn: (message) => params.runtime.error(message) },
          });
          if (!result.ok) {
            throw new Error(result.error);
          }
        }
      } else {
        const entry = resolveOfficialEntry(match.candidate.id);
        if (!entry) {
          throw new Error(t("wizard.appRecommendations.catalogEntryMissing"));
        }
        const pluginResult = await ensureOnboardingPluginInstalled({
          cfg: next,
          entry,
          prompter: params.prompter,
          runtime: params.runtime,
          workspaceDir: params.workspaceDir,
          promptInstall: false,
        });
        next = pluginResult.cfg;
        if (!pluginResult.installed) {
          throw new Error(pluginResult.error ?? pluginResult.status);
        }
      }
      installed = true;
    } catch (error) {
      retryMatches.push(match);
      params.runtime.error(
        t("wizard.appRecommendations.installFailed", {
          name: match.candidate.displayName,
          reason: formatErrorMessage(error),
        }),
      );
    }
    if (installed && match.candidate.source === "clawhub-skill") {
      // Skill installation is already durable on disk. Checkpoint it now so a
      // later crash cannot turn an existing target into a permanent retry.
      pendingMatches = pendingMatches.filter((candidate) => candidate !== match);
      await recordResult(pendingMatches);
    }
  }
  // Official plugin config is durable only after the caller writes `next`.
  // Commit recommendation outcomes at that owner boundary, never inside the install catch.
  const hasDeferredOfficialResult = selectedMatches.some(
    (match) => match.candidate.source !== "clawhub-skill",
  );
  return {
    config: next,
    commitResult: hasDeferredOfficialResult
      ? () => recordResult(retryMatches)
      : async () => undefined,
  };
}
