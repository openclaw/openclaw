import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateSkillInstallPolicy } from "../plugins/install-security-scan.js";
import { installExtractedSkillRoot } from "../skills/lifecycle/archive-install.js";
import {
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "../skills/lifecycle/install-paths.js";
import { loadSingleSkillDirectory } from "../skills/loading/local-loader.js";
import {
  snapshotTemplateDependencyDirectory,
  materializeTemplateDependencyDirectory,
  type TemplateDirectorySnapshot,
} from "./dependency-directory.js";
import { digestTemplateBytes, digestTemplateValue } from "./digest.js";
import type { InstallTemplatePackagesOptions } from "./package-install-options.js";
import type { PlannedTemplateBundledDependency } from "./package-plan-action.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import type { TemplatePackagePreflightResult } from "./types.js";

export function inspectTemplateBundledSkill(
  rootDir: string,
  path: string,
  snapshot: TemplateDirectorySnapshot,
) {
  const file = snapshot.files.find((entry) => entry.path === "SKILL.md");
  if (!file) {
    throw new Error(`Bundled skill ${path} is missing SKILL.md.`);
  }
  const skillDir = resolve(rootDir, path);
  const loaded = loadSingleSkillDirectory({
    skillDir,
    rootRealPath: skillDir,
    source: "template-bundled",
    maxBytes: MAX_MANAGED_FILE_BYTES,
  });
  if (!loaded || digestTemplateBytes(Buffer.from(loaded.content)) !== file.digest) {
    throw new Error(`Bundled skill ${path} has invalid or changed SKILL.md.`);
  }
  let installId: string;
  try {
    installId = validateRequestedSkillSlug(loaded.skill.name);
  } catch {
    installId = validateRequestedSkillSlug(basename(path));
  }
  return { name: loaded.skill.name, installId };
}

export async function preflightBundledTemplateSkill(params: {
  rootDir: string;
  path: string;
  workspace: string;
  snapshot?: TemplateDirectorySnapshot;
  config?: OpenClawConfig;
}): Promise<TemplatePackagePreflightResult> {
  try {
    const snapshot =
      params.snapshot ??
      (await snapshotTemplateDependencyDirectory({ rootDir: params.rootDir, path: params.path }));
    const identity = inspectTemplateBundledSkill(params.rootDir, params.path, snapshot);
    const target = resolveWorkspaceSkillInstallDir(params.workspace, identity.installId);
    const existing = await lstat(target).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      const installed = await snapshotTemplateDependencyDirectory({ rootDir: target });
      if (installed.digest !== snapshot.digest) {
        return {
          ok: false,
          code: "bundled_skill_conflict",
          message: `Skill ${identity.name} already exists with different contents.`,
        };
      }
    }
    if (existing) {
      return { ok: true, action: "reuse", ...identity, snapshot };
    }
    await using prepared = await materializeTemplateDependencyDirectory({
      rootDir: params.rootDir,
      path: params.path,
      snapshot,
    });
    const scan = await evaluateSkillInstallPolicy({
      ...bundledSkillPolicy(params.path, params.config),
      logger: {},
      skillName: identity.installId,
      sourceDir: prepared.directory,
      mode: "install",
    });
    if (scan?.blocked && !scan.blocked.installPolicyWarning) {
      return {
        ok: false,
        code: scan.blocked.code ?? "bundled_skill_policy_blocked",
        message: scan.blocked.reason,
      };
    }
    return {
      ok: true,
      action: "install",
      ...identity,
      snapshot,
      ...(scan?.blocked?.installPolicyWarning
        ? {
            warning: scan.blocked.reason,
            installPolicyWarningDigest: digestTemplateValue(scan.blocked.installPolicyWarning),
          }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      code: "bundled_skill_invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installBundledTemplateSkill(params: {
  rootDir: string;
  workspace: string;
  dependency: PlannedTemplateBundledDependency;
  options: InstallTemplatePackagesOptions;
}): Promise<void> {
  const { dependency, options } = params;
  const current = await preflightBundledTemplateSkill({
    rootDir: params.rootDir,
    path: dependency.path,
    workspace: params.workspace,
    config: options.config,
  });
  if (
    !current.ok ||
    current.snapshot?.digest !== dependency.snapshot.digest ||
    current.action !== dependency.ownerAction ||
    current.installId !== dependency.installId ||
    current.name !== dependency.name ||
    current.warning !== dependency.riskWarning ||
    current.installPolicyWarningDigest !== dependency.installPolicyWarningDigest
  ) {
    throw new Error("Bundled skill changed after planning; create a fresh Add plan.");
  }
  options.assertCurrent?.();
  if (current.action === "reuse") {
    return;
  }
  if (dependency.riskWarning) {
    if (!options.skillConsent) {
      throw new Error("Bundled skill requires an explicit trust warning acknowledgement.");
    }
    options.skillConsent.assertApproved({
      source: "bundled",
      path: dependency.path,
      name: dependency.name,
      digest: dependency.snapshot.digest,
      riskWarning: dependency.riskWarning,
    });
  }
  await using prepared = await materializeTemplateDependencyDirectory({
    rootDir: params.rootDir,
    path: dependency.path,
    snapshot: dependency.snapshot,
  });
  const installed = await installExtractedSkillRoot({
    workspaceDir: params.workspace,
    slug: dependency.installId,
    extractedRoot: prepared.directory,
    mode: "install",
    beforePersistentApply: () => {
      options.assertCurrent?.();
      options.assertForwardCurrent?.();
    },
    beforePersistentEffect: async () => {
      await options.prepareEffect?.();
      options.assertCurrent?.();
      options.assertForwardCurrent?.();
    },
    policy: {
      ...bundledSkillPolicy(dependency.path, options.config),
      onInstallPolicyWarning: async (request) => {
        if (
          !dependency.riskWarning ||
          digestTemplateValue(request) !== dependency.installPolicyWarningDigest ||
          !options.skillConsent
        ) {
          return { status: "declined" };
        }
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
        options.skillConsent.assertApproved({
          source: "bundled",
          path: dependency.path,
          name: dependency.name,
          digest: dependency.snapshot.digest,
          riskWarning: dependency.riskWarning,
        });
        return { status: "approved" };
      },
    },
  });
  if (!installed.ok) {
    throw new Error(installed.error);
  }
}

function bundledSkillPolicy(path: string, config?: OpenClawConfig) {
  return {
    config,
    installId: "template-bundled",
    origin: { type: "path" as const, spec: path },
    source: {
      kind: "local-path" as const,
      authority: "third-party" as const,
      mutable: false,
      network: false,
    },
    requestedSpecifier: path,
  };
}
