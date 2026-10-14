import path from "node:path";
import { coerceErrorMessage as formatPackageReadFailure } from "@openclaw/normalization-core/error-coercion";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
} from "../plugins/install-paths.js";
import {
  loadInstalledPluginIndexInstallRecords,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { listManagedPluginNpmRootsSync } from "../plugins/npm-project-roots.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  reconcileRegisteredOpenClawHostLinks,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "../plugins/plugin-peer-link.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type PluginHostLinkDoctorParams = InstalledPluginIndexRecordStoreOptions & {
  prompter: Pick<DoctorPrompter, "shouldRepair">;
};

type PluginPackageReadFailure = {
  packageDir: string;
  reason: string;
};

function resolveRegisteredPluginExtensionsRoot(
  params: InstalledPluginIndexRecordStoreOptions,
): string {
  return params.stateDir
    ? path.join(params.stateDir, "extensions")
    : resolveDefaultPluginExtensionsDir(params.env);
}

export function resolveDoctorPluginNpmRoots(
  params: InstalledPluginIndexRecordStoreOptions,
): string[] {
  const npmRoot = params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
  return listManagedPluginNpmRootsSync(npmRoot);
}

/** Audits managed npm and registered plugin host links without mutating either root. */
export async function listPluginOpenClawHostLinkIssues(
  params: InstalledPluginIndexRecordStoreOptions,
) {
  const packageReadFailures: PluginPackageReadFailure[] = [];
  const registeredPackageReadFailures: PluginPackageReadFailure[] = [];
  const recordReadFailure =
    (failures: PluginPackageReadFailure[]) => (error: unknown, packageDir: string) => {
      failures.push({ packageDir, reason: formatPackageReadFailure(error) });
    };
  const audits = await Promise.all(
    resolveDoctorPluginNpmRoots(params).map((npmRoot) =>
      auditOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        onPackageReadError: recordReadFailure(packageReadFailures),
      }),
    ),
  );
  const registeredAudit = await reconcileRegisteredOpenClawHostLinks({
    installRecords: await loadInstalledPluginIndexInstallRecords(params),
    extensionsDir: resolveRegisteredPluginExtensionsRoot(params),
    env: params.env,
    mode: "audit",
    onPackageReadError: recordReadFailure(registeredPackageReadFailures),
  });
  return {
    peerLinkIssues: audits.flatMap((audit) => audit.issues),
    packageReadFailures,
    registeredPeerLinkIssues: registeredAudit.issues,
    registeredPackageReadFailures,
  };
}

export async function maybeRepairPluginOpenClawHostLinks(
  params: PluginHostLinkDoctorParams,
): Promise<boolean> {
  const npmRoots = resolveDoctorPluginNpmRoots(params);
  if (!params.prompter.shouldRepair) {
    const audit = await listPluginOpenClawHostLinkIssues(params);
    const reportLinks = (
      issues: readonly { packageName: string; reason: string }[],
      label: string,
      packages: string,
    ) => {
      if (issues.length > 0) {
        note(
          [
            `${label} need repair:`,
            ...issues.map((issue) => `- ${issue.packageName}: ${issue.reason}`),
            `Repair with ${formatCliCommand("openclaw doctor --fix")} to relink ${packages} plugin packages.`,
          ].join("\n"),
          "Plugin registry",
        );
      }
    };
    reportLinks(audit.peerLinkIssues, "Managed npm OpenClaw host peer links", "managed npm");
    for (const [label, failures] of [
      ["Managed npm plugin", audit.packageReadFailures],
      ["Registered plugin", audit.registeredPackageReadFailures],
    ] as const) {
      if (failures.length > 0) {
        note(
          [
            `${label} packages could not be inspected:`,
            ...failures.map(
              (failure) => `- ${shortenHomePath(failure.packageDir)}: ${failure.reason}`,
            ),
          ].join("\n"),
          "Plugin registry",
        );
      }
    }
    reportLinks(
      audit.registeredPeerLinkIssues,
      "Registered plugin OpenClaw host links",
      "registered",
    );
    return false;
  }

  const warnings: string[] = [];
  const logger = {
    info() {},
    warn: (message: string) => warnings.push(`- ${message}`),
  };
  const warnReadFailure = (kind: string) => (error: unknown, packageDir: string) => {
    logger.warn(
      `Could not inspect ${kind} package ${shortenHomePath(packageDir)}: ${formatPackageReadFailure(error)}`,
    );
  };
  const results = await Promise.all(
    npmRoots.map((npmRoot) =>
      relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        logger,
        onPackageReadError: warnReadFailure("managed npm"),
      }),
    ),
  );
  const repaired = results.reduce((total, result) => total + result.repaired, 0);
  const registeredRepair = await reconcileRegisteredOpenClawHostLinks({
    installRecords: await loadInstalledPluginIndexInstallRecords(params),
    extensionsDir: resolveRegisteredPluginExtensionsRoot(params),
    env: params.env,
    mode: "repair",
    logger,
    onPackageReadError: warnReadFailure("registered"),
  });

  for (const [count, kind] of [
    [repaired, "managed npm"],
    [registeredRepair.repaired, "registered"],
  ] as const) {
    if (count > 0) {
      note(
        `Repaired OpenClaw host peer link(s) for ${count} ${kind} plugin package(s).`,
        "Plugin registry",
      );
    }
  }
  if (warnings.length > 0) {
    note(
      ["Could not repair all managed OpenClaw host peer links:", ...warnings].join("\n"),
      "Plugin registry",
    );
  }

  return repaired > 0 || registeredRepair.repaired > 0;
}
