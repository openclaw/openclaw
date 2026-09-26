// Setup security note helpers render security guidance during onboarding.
import chalk from "chalk";
import { formatCliCommand } from "../cli/command-format.js";
import { t } from "./i18n/index.js";

export function getSecurityNoteTitle(): string {
  return t("wizard.security.title");
}

export function getSecurityNoteMessage(): string {
  return [
    t("wizard.security.attribution"),
    t("wizard.security.personalAgent"),
    t("wizard.security.toolAccess"),
    t("wizard.security.promptRisk"),
    "",
    t("wizard.security.notMultitenant"),
    t("wizard.security.sharedAuthority"),
    "",
    t("wizard.security.hardeningRequired"),
    t("wizard.security.askForHelp"),
    "",
    chalk.bold(t("wizard.security.recommendedBaseline")),
    `- ${t("wizard.security.baselinePairing")}`,
    `- ${t("wizard.security.baselineSharedInbox")}`,
    `- ${t("wizard.security.baselineSandbox")}`,
    `- ${t("wizard.security.baselineDmSessions")}`,
    `- ${t("wizard.security.baselineSecrets")}`,
    `- ${t("wizard.security.baselineStrongModel")}`,
    "",
    chalk.bold(t("wizard.security.runRegularly")),
    formatCliCommand("openclaw security audit --deep"),
    formatCliCommand("openclaw security audit --fix"),
    "",
    `${t("wizard.security.learnMore")} https://docs.openclaw.ai/gateway/security`,
  ].join("\n");
}
