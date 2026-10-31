import path from "node:path";
import { coerceErrorMessage as formatPackageReadFailure } from "@openclaw/normalization-core/error-coercion";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
} from "../plugins/install-paths.js";
import {
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsAsync,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { listManagedPluginNpmRootsForInstallRecords } from "../plugins/installed-plugin-npm-roots.js";
import { listManagedPluginNpmRootsSync } from "../plugins/npm-project-roots.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  reconcileRegisteredOpenClawHostLinks,
  repairInstalledOpenClawHostLinks,
} from "../plugins/plugin-peer-link.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type PluginHostLinkDoctorParams = InstalledPluginIndexRecordStoreOptions & {
  prompter: Pick<DoctorPrompter, "shouldRepair">;
  installRecords?: Record<string, PluginInstallRecord>;
  beforePersistentEffect?: () => void | Promise<void>;
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

async function loadHostLinkInstallRecords(params: InstalledPluginIndexRecordStoreOptions) {
  let records;
  try {
    records = await readPersistedInstalledPluginIndexInstallRecordsAsync(params);
  } catch (error) {
    // Invalid records and lost read authority still refuse repair. Only unreadable
    // storage falls back to discovery so a recoverable I/O hiccup stays best effort.
    if (
      !["EACCES", "EPERM", "EIO", "SQLITE_CANTOPEN", "SQLITE_IOERR"].some((code) =>
        hasErrnoCode(error, code),
      )
    ) {
      throw error;
    }
    return null;
  }
  // Recovery discovers every generation; a readable ledger already owns selection.
  return records ?? (await loadInstalledPluginIndexInstallRecords(params));
}

function resolveHostLinkNpmRoots(
  params: InstalledPluginIndexRecordStoreOptions,
  installRecords: Awaited<ReturnType<typeof loadHostLinkInstallRecords>>,
) {
  return listManagedPluginNpmRootsForInstallRecords({
    npmRoot: params.stateDir
      ? path.join(params.stateDir, "npm")
      : resolveDefaultPluginNpmDir(params.env),
    installRecords,
    env: params.env,
  });
}

/** Audits managed npm and registered plugin host links without mutating either root. */
export async function listPluginOpenClawHostLinkIssues(
  params: InstalledPluginIndexRecordStoreOptions,
) {
  const installRecords = await loadHostLinkInstallRecords(params);
  const packageReadFailures: PluginPackageReadFailure[] = [];
  const registeredPackageReadFailures: PluginPackageReadFailure[] = [];
  const recordReadFailure =
    (failures: PluginPackageReadFailure[]) => (error: unknown, packageDir: string) => {
      failures.push({ packageDir, reason: formatPackageReadFailure(error) });
    };
  const audits = await Promise.all(
    resolveHostLinkNpmRoots(params, installRecords).map((npmRoot) =>
      auditOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        onPackageReadError: recordReadFailure(packageReadFailures),
      }),
    ),
  );
  const registeredAudit = await reconcileRegisteredOpenClawHostLinks({
    installRecords: installRecords ?? {},
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

  const installRecords = params.installRecords ?? (await loadHostLinkInstallRecords(params));
  const npmRoots = resolveHostLinkNpmRoots(params, installRecords);

  const warnings: string[] = [];
  const logger = {
    info() {},
    warn: (message: string) => warnings.push(`- ${message}`),
  };
  const repair = await repairInstalledOpenClawHostLinks({
    managedNpmRoots: npmRoots,
    installRecords: installRecords ?? {},
    extensionsDir: resolveRegisteredPluginExtensionsRoot(params),
    env: params.env,
    logger,
    onPackageReadError: (error, packageDir, kind) => {
      logger.warn(
        `Could not inspect ${kind} package ${shortenHomePath(packageDir)}: ${formatPackageReadFailure(error)}`,
      );
    },
    beforePersistentEffect: params.beforePersistentEffect,
  });

  for (const [count, kind] of [
    [repair.managedRepaired, "managed npm"],
    [repair.registeredRepaired, "registered"],
  ] as const) {
    if (count > 0) {
      note(
        `Repaired OpenClaw host peer link(s) for ${count} ${kind} plugin package(s).`,
        "Plugin registry",
      );
    }
  }
  if (warnings.length > 0) {
    note(["OpenClaw host peer link warnings:", ...warnings].join("\n"), "Plugin registry");
  }

  return repair.managedRepaired > 0 || repair.registeredRepaired > 0;
}
