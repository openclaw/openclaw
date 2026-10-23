import fs from "node:fs";
import path from "node:path";
import {
  resolveOnboardingWorkspaceConflict,
  type OnboardingWorkspaceConflict,
} from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMissingPathError } from "../infra/errno.js";
import { extractErrorCode, formatErrorMessageWithCode } from "../infra/errors.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

export function validateSetupWorkspacePath(workspaceDir: string): string | undefined {
  let candidate = resolveUserPath(workspaceDir);
  while (true) {
    try {
      let stats = fs.lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        try {
          stats = fs.statSync(candidate);
        } catch (error) {
          if (isMissingPathError(error)) {
            return t("wizard.setup.workspaceSymlinkNotDirectory", { path: candidate });
          }
          throw error;
        }
      }
      return stats.isDirectory()
        ? undefined
        : t("wizard.setup.workspaceNotDirectory", { path: candidate });
    } catch (error) {
      if (!isMissingPathError(error)) {
        return extractErrorCode(error) === "ELOOP"
          ? t("wizard.setup.workspaceSymlinkLoop", { path: candidate })
          : t("wizard.setup.workspacePathError", {
              path: candidate,
              error: formatErrorMessageWithCode(error),
            });
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return t("wizard.setup.workspaceNotDirectory", { path: candidate });
    }
    candidate = parent;
  }
}

/** Resolves a proposed setup workspace without silently remapping an existing fleet. */
export async function resolveSetupWorkspaceSelection(params: {
  baseConfig: OpenClawConfig;
  requestedWorkspaceDir: string;
  prompter: WizardPrompter;
  canConfirmMove?: boolean;
  hasAuthoredRoster?: boolean;
  /** Workspace already approved by the current setup receipt. */
  approvedWorkspaceDir?: string;
}): Promise<{
  workspaceDir: string;
  allowWorkspaceChange: boolean;
  conflict?: OnboardingWorkspaceConflict;
}> {
  const workspaceError = validateSetupWorkspacePath(params.requestedWorkspaceDir);
  if (workspaceError) {
    throw new Error(workspaceError);
  }
  if (
    params.approvedWorkspaceDir &&
    resolveUserPath(params.approvedWorkspaceDir) === resolveUserPath(params.requestedWorkspaceDir)
  ) {
    return { workspaceDir: params.requestedWorkspaceDir, allowWorkspaceChange: true };
  }
  const conflict =
    params.hasAuthoredRoster === false
      ? undefined
      : resolveOnboardingWorkspaceConflict(params.baseConfig, params.requestedWorkspaceDir);
  if (!conflict) {
    return { workspaceDir: params.requestedWorkspaceDir, allowWorkspaceChange: false };
  }
  await params.prompter.note(
    t("wizard.setup.workspaceConflictNotice", {
      current: shortenHomePath(conflict.currentWorkspaceDir),
      requested: shortenHomePath(conflict.requestedWorkspaceDir),
    }),
    t("wizard.setup.workspaceConflictTitle"),
  );
  const allowWorkspaceChange =
    params.canConfirmMove !== false &&
    (await params.prompter.confirm({
      message: t("wizard.setup.workspaceConflictConfirm"),
      initialValue: false,
    }));
  return {
    workspaceDir: allowWorkspaceChange
      ? params.requestedWorkspaceDir
      : conflict.currentWorkspaceDir,
    allowWorkspaceChange,
    conflict,
  };
}
