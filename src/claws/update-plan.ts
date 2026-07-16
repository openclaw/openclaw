// Builds read-only, agent-centric Claw update plans from grouped manifests and ownership state.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { stableStringify } from "../agents/stable-stringify.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan, type ClawAddPlanContext } from "./lifecycle.js";
import { digestClawMcpServer, readClawMcpServerRefsByName } from "./mcp.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import { readClawPackageRefs } from "./provenance.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawSourceIdentity,
} from "./types.js";

export const CLAW_UPDATE_PLAN_SCHEMA_VERSION = "openclaw.clawUpdatePlan.v1" as const;

export type ClawUpdateAction = {
  kind: "agent" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "add" | "change" | "remove" | "release" | "unchanged" | "manual";
  target: string;
  blocked: boolean;
  reason: string;
  currentDigest?: string;
  desiredDigest?: string;
};

export type ClawUpdatePlan = {
  schemaVersion: typeof CLAW_UPDATE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  found: boolean;
  agentId: string;
  currentClaw?: { name: string; version: string; integrity: string };
  targetClaw?: { name: string; version: string; integrity: string };
  summary: {
    totalActions: number;
    added: number;
    changed: number;
    removed: number;
    released: number;
    unchanged: number;
    manual: number;
    blocked: number;
  };
  actions: ClawUpdateAction[];
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function diagnostic(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

function summarize(actions: ClawUpdateAction[]): ClawUpdatePlan["summary"] {
  return {
    totalActions: actions.length,
    added: actions.filter((action) => action.action === "add").length,
    changed: actions.filter((action) => action.action === "change").length,
    removed: actions.filter((action) => action.action === "remove").length,
    released: actions.filter((action) => action.action === "release").length,
    unchanged: actions.filter((action) => action.action === "unchanged").length,
    manual: actions.filter((action) => action.action === "manual").length,
    blocked: actions.filter((action) => action.blocked).length,
  };
}

function emptyPlan(params: {
  agentId: string;
  source?: ClawSourceIdentity;
  currentClaw?: ClawUpdatePlan["currentClaw"];
  found?: boolean;
  blockers: ClawDiagnostic[];
  diagnostics?: ClawDiagnostic[];
}): ClawUpdatePlan {
  const plan: Omit<ClawUpdatePlan, "planIntegrity"> = {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: params.found ?? false,
    agentId: params.agentId,
    ...(params.currentClaw ? { currentClaw: params.currentClaw } : {}),
    ...(params.source
      ? {
          targetClaw: {
            name: params.source.name,
            version: params.source.version,
            integrity: params.source.integrity,
          },
        }
      : {}),
    summary: summarize([]),
    actions: [],
    blockers: params.blockers,
    diagnostics: params.diagnostics ?? [],
  };
  return { ...plan, planIntegrity: digest(plan) };
}

function manualState(state: string): boolean {
  return state === "modified" || state === "unsafe" || state === "pending" || state === "failed";
}

export async function buildClawUpdatePlan(params: {
  agentId: string;
  targetManifest: ClawManifest;
  targetSource: ClawSourceIdentity;
  config: OpenClawConfig;
  sourceMcpServers: Record<string, Record<string, unknown>>;
  stateOptions?: OpenClawStateDatabaseOptions & { packageDeps?: PackageRemovalDeps };
  packagePreflight?: ClawAddPlanContext["packagePreflight"];
  diagnostics?: ClawDiagnostic[];
}): Promise<ClawUpdatePlan> {
  const ownsDatabase = !params.stateOptions?.database;
  const database =
    params.stateOptions?.database ?? openExistingOpenClawStateDatabaseReadOnly(params.stateOptions);
  if (!database) {
    return emptyPlan({
      agentId: params.agentId,
      source: params.targetSource,
      blockers: [
        diagnostic(
          "claw_not_found",
          "$",
          `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
        ),
      ],
      diagnostics: params.diagnostics,
    });
  }
  if (
    !database.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
      .get()
  ) {
    if (ownsDatabase) {
      database.walMaintenance.close();
    }
    return emptyPlan({
      agentId: params.agentId,
      source: params.targetSource,
      blockers: [
        diagnostic(
          "claw_not_found",
          "$",
          `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
        ),
      ],
      diagnostics: params.diagnostics,
    });
  }
  const readOnlyStateOptions: OpenClawStateDatabaseOptions & {
    packageDeps?: PackageRemovalDeps;
  } = {
    ...params.stateOptions,
    database,
    readOnly: true,
  };
  try {
    const status = await readClawStatus(params.agentId, {
      ...readOnlyStateOptions,
      config: params.config,
      sourceMcpServers: params.sourceMcpServers,
    });
    if (status.records.length === 0) {
      return emptyPlan({
        agentId: params.agentId,
        source: params.targetSource,
        blockers: [
          diagnostic(
            "claw_not_found",
            "$",
            `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
          ),
        ],
        diagnostics: params.diagnostics,
      });
    }
    if (status.records.length > 1) {
      return emptyPlan({
        agentId: params.agentId,
        source: params.targetSource,
        found: true,
        blockers: [
          diagnostic(
            "claw_ambiguous",
            "$",
            `Claw name ${JSON.stringify(params.agentId)} matches multiple agents; use an agent id.`,
          ),
        ],
        diagnostics: params.diagnostics,
      });
    }
    const record = status.records[0]!;
    const agentId = record.install.agentId;
    if (record.install.claw.name !== params.targetSource.name) {
      return emptyPlan({
        agentId,
        source: params.targetSource,
        found: true,
        currentClaw: {
          name: record.install.claw.name,
          version: record.install.claw.version,
          integrity: record.install.claw.integrity,
        },
        blockers: [
          diagnostic(
            "claw_identity_mismatch",
            "$.name",
            `Target package ${JSON.stringify(params.targetSource.name)} does not match installed Claw ${JSON.stringify(record.install.claw.name)}.`,
          ),
        ],
        diagnostics: params.diagnostics,
      });
    }

    const packageKey = (value: { kind: string; ref: string }) => `${value.kind}:${value.ref}`;
    const packagePreflights = new Map<
      string,
      {
        ok: boolean;
        action?: "install" | "reuse";
        code?: string;
        message?: string;
        installedVersion?: string;
      }
    >();
    const targetPlan = await buildClawAddPlan({
      manifest: params.targetManifest,
      source: params.targetSource,
      diagnostics: params.diagnostics,
      context: {
        agentId,
        workspace: record.install.workspace,
        packagePreflight: async (pkg) => {
          const result = params.packagePreflight
            ? await params.packagePreflight(pkg)
            : {
                ok: false,
                code: "package_install_unavailable",
                message: "Package preflight is unavailable.",
              };
          packagePreflights.set(packageKey(pkg), result);
          return result;
        },
      },
    });
    const blockers = targetPlan.blockers.filter(
      (entry) =>
        entry.code !== "workspace_collision" &&
        entry.code !== "agent_id_collision" &&
        !entry.path.startsWith("$.packages"),
    );
    const actions: ClawUpdateAction[] = [];

    const desiredAgentDigest = digest(targetPlan.agent.config);
    const agentAction =
      record.agentState === "modified"
        ? "manual"
        : record.agentState === "missing"
          ? "change"
          : record.install.agentConfigDigest === desiredAgentDigest
            ? "unchanged"
            : "change";
    actions.push({
      kind: "agent",
      id: agentId,
      action: agentAction,
      target: `agents.list.${agentId}`,
      blocked: agentAction === "manual",
      reason:
        agentAction === "manual"
          ? "Live agent config changed after installation and must be reconciled manually."
          : record.agentState === "missing"
            ? "Owned agent config is missing and would be restored from the target manifest."
            : agentAction === "unchanged"
              ? "Owned agent config already matches the target manifest."
              : "Target manifest changes owned agent config.",
      currentDigest: record.install.agentConfigDigest,
      desiredDigest: desiredAgentDigest,
    });

    const targetFiles = new Map(
      targetPlan.actions
        .filter((action) => action.kind === "workspaceFile")
        .map((action) => [action.id, action] as const),
    );
    const currentFiles = new Map(record.workspaceFiles.map((file) => [file.path, file] as const));
    let workspace: Awaited<ReturnType<typeof fsSafeRoot>> | undefined;
    let workspaceState: "present" | "missing" | "unsafe" = "present";
    try {
      const workspaceStat = await lstat(record.install.workspace);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
        workspaceState = "unsafe";
      } else {
        workspace = await fsSafeRoot(record.install.workspace, {
          hardlinks: "reject",
          symlinks: "reject",
        });
      }
    } catch (error) {
      workspaceState =
        error && typeof error === "object" && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unsafe";
    }
    for (const [path, target] of targetFiles) {
      const current = currentFiles.get(path);
      if (!target.digest) {
        actions.push({
          kind: "workspaceFile",
          id: path,
          action: "manual",
          target: `${record.install.workspace}:${path}`,
          blocked: true,
          reason: target.reason ?? "Target workspace source could not be verified.",
        });
        continue;
      }
      let unownedDestination: "absent" | "occupied" | "unsafe" =
        workspaceState === "unsafe" ? "unsafe" : "absent";
      if (!current) {
        if (workspace) {
          try {
            unownedDestination = (await workspace.exists(path)) ? "occupied" : "absent";
          } catch {
            unownedDestination = "unsafe";
          }
        }
      }
      const currentFileRequiresManual =
        current !== undefined &&
        manualState(current.state) &&
        !(workspaceState === "missing" && current.state === "unsafe");
      const action =
        workspaceState === "unsafe"
          ? "manual"
          : !current && unownedDestination !== "absent"
            ? "manual"
            : !current
              ? "add"
              : currentFileRequiresManual
                ? "manual"
                : current.contentDigest === target.digest && current.state === "unchanged"
                  ? "unchanged"
                  : "change";
      actions.push({
        kind: "workspaceFile",
        id: path,
        action,
        target: `${record.install.workspace}:${path}`,
        blocked: action === "manual",
        reason:
          unownedDestination === "occupied"
            ? "Workspace path already exists without Claw ownership and must be preserved."
            : unownedDestination === "unsafe"
              ? "Workspace path is unsafe to inspect and cannot be claimed automatically."
              : workspaceState === "missing" && current
                ? "Owned workspace is missing and this file would be restored."
                : action === "add"
                  ? "Target manifest adds a managed workspace file."
                  : action === "manual"
                    ? "Local workspace content changed or became unsafe and must be reconciled manually."
                    : action === "unchanged"
                      ? "Managed workspace content already matches the target source."
                      : "Target source changes or restores managed workspace content.",
        ...(current ? { currentDigest: current.contentDigest } : {}),
        desiredDigest: target.digest,
      });
    }
    for (const current of record.workspaceFiles) {
      if (targetFiles.has(current.path)) {
        continue;
      }
      const manual =
        workspaceState === "unsafe" ||
        (manualState(current.state) &&
          !(workspaceState === "missing" && current.state === "unsafe"));
      actions.push({
        kind: "workspaceFile",
        id: current.path,
        action: manual ? "manual" : "remove",
        target: `${current.workspace}:${current.path}`,
        blocked: manual,
        reason: manual
          ? "Target removes this file, but local drift must be preserved manually."
          : "Target manifest removes this managed workspace file.",
        currentDigest: current.contentDigest,
      });
    }

    const allPackages = readClawPackageRefs(readOnlyStateOptions);
    const currentPackages = new Map(record.packages.map((pkg) => [packageKey(pkg), pkg] as const));
    const targetPackages = new Map(
      params.targetManifest.packages.map((pkg) => [packageKey(pkg), pkg] as const),
    );
    for (const [key, target] of targetPackages) {
      const current = currentPackages.get(key);
      const preflight = packagePreflights.get(key);
      const requiresPackageMutation =
        !current ||
        (current.ownership === "claw-installed" &&
          (current.state === "missing" || current.version !== target.version));
      const expectedOwnedPluginUpgradeConflict =
        target.kind === "plugin" &&
        current?.state === "present" &&
        current.ownership === "claw-installed" &&
        current.version !== target.version &&
        preflight?.code === "plugin_version_conflict" &&
        preflight.installedVersion === current.version;
      const failedPackageMutationPreflight =
        requiresPackageMutation && !preflight?.ok && !expectedOwnedPluginUpgradeConflict;
      const conflictingPluginPin =
        target.kind === "plugin" &&
        allPackages.some(
          (candidate) =>
            candidate.agentId !== agentId &&
            candidate.kind === target.kind &&
            candidate.source === target.source &&
            candidate.ref === target.ref &&
            candidate.version !== target.version,
        );
      const unresolvedCurrent =
        current && ["modified", "ambiguous", "incomplete"].includes(current.state);
      const independentlyOwnedMutation =
        current &&
        current.ownership !== "claw-installed" &&
        (current.state === "missing" || current.version !== target.version);
      const action =
        conflictingPluginPin ||
        unresolvedCurrent ||
        independentlyOwnedMutation ||
        failedPackageMutationPreflight
          ? "manual"
          : !current
            ? "add"
            : current.state === "missing"
              ? "change"
              : current.version === target.version
                ? "unchanged"
                : "change";
      actions.push({
        kind: "package",
        id: key,
        action,
        target: `${target.source}:${target.ref}@${target.version}`,
        blocked: action === "manual",
        reason:
          action === "manual"
            ? conflictingPluginPin
              ? "Another Claw pins an incompatible version of this shared plugin."
              : independentlyOwnedMutation
                ? "Package is independently owned and cannot be restored or changed by this Claw."
                : failedPackageMutationPreflight
                  ? (preflight?.message ?? "Package preflight failed.")
                  : `Current package lifecycle state is ${current?.state ?? "unknown"} and must be reconciled manually.`
            : action === "add"
              ? "Target manifest adds a package reference."
              : action === "unchanged"
                ? "Recorded package reference already matches the exact target version."
                : "Target manifest changes the exact package version.",
        ...(current ? { currentDigest: digest(current) } : {}),
        desiredDigest: digest(target),
      });
      if (failedPackageMutationPreflight) {
        const index = params.targetManifest.packages.findIndex((pkg) => packageKey(pkg) === key);
        blockers.push(
          diagnostic(
            preflight?.code ?? "package_install_unavailable",
            `$.packages[${index}]`,
            preflight?.message ?? "Package preflight failed.",
          ),
        );
      }
    }
    for (const [key, current] of currentPackages) {
      if (!targetPackages.has(key)) {
        const manual = current.state === "incomplete";
        actions.push({
          kind: "package",
          id: key,
          action: manual ? "manual" : "remove",
          target: `${current.source}:${current.ref}@${current.version}`,
          blocked: manual,
          reason: manual
            ? `Target removes this package, but current lifecycle state is ${current.state}.`
            : "Target manifest removes this Claw package reference without implying shared uninstall.",
          currentDigest: digest(current),
        });
      }
    }

    const configuredMcpServers = normalizeConfiguredMcpServers(params.sourceMcpServers);
    const currentMcp = new Map(record.mcpServers.map((server) => [server.name, server] as const));
    for (const [name, target] of Object.entries(params.targetManifest.mcpServers)) {
      const current = currentMcp.get(name);
      const desiredDigest = digestClawMcpServer(target);
      const unownedLiveServer = !current && Object.hasOwn(configuredMcpServers, name);
      const sharedWithOtherClaws =
        current &&
        readClawMcpServerRefsByName(name, readOnlyStateOptions).some(
          (candidate) => candidate.agentId !== agentId,
        );
      const independentlyOwnedMutation =
        current?.ownership === "independently-owned" &&
        (current.configDigest !== desiredDigest || current.state !== "present");
      const sharedChange = sharedWithOtherClaws && current?.configDigest !== desiredDigest;
      const action =
        unownedLiveServer || independentlyOwnedMutation || sharedChange
          ? "manual"
          : !current
            ? "add"
            : manualState(current.state)
              ? "manual"
              : current.configDigest === desiredDigest && current.state === "present"
                ? "unchanged"
                : "change";
      actions.push({
        kind: "mcpServer",
        id: name,
        action,
        target: `mcp.servers.${name}`,
        blocked: action === "manual",
        reason: unownedLiveServer
          ? "MCP server name already exists without this Claw's ownership."
          : independentlyOwnedMutation
            ? "MCP server is independently owned and cannot be restored or changed by this Claw."
            : sharedChange
              ? "Another Claw shares this MCP declaration and blocks changing global config."
              : action === "manual"
                ? "MCP ownership is unresolved or live config drifted and must be reconciled manually."
                : action === "unchanged"
                  ? "Owned MCP config digest already matches the target declaration."
                  : `Target manifest ${action === "add" ? "adds" : "changes or restores"} this MCP declaration.`,
        ...(current ? { currentDigest: current.configDigest } : {}),
        desiredDigest,
      });
    }
    for (const current of record.mcpServers) {
      if (Object.hasOwn(params.targetManifest.mcpServers, current.name)) {
        continue;
      }
      const manual = current.state === "pending" || current.state === "failed";
      const sharedOrIndependent =
        current.ownership === "independently-owned" ||
        readClawMcpServerRefsByName(current.name, readOnlyStateOptions).some(
          (candidate) => candidate.agentId !== agentId,
        );
      const ownerAction =
        current.state === "present" && !sharedOrIndependent ? "remove" : "release";
      actions.push({
        kind: "mcpServer",
        id: current.name,
        action: manual ? "manual" : ownerAction,
        target: `mcp.servers.${current.name}`,
        blocked: manual,
        reason: manual
          ? "Target removes this MCP declaration, but ownership is incomplete."
          : ownerAction === "release"
            ? "Target manifest releases this Claw's reference while preserving shared or independently owned MCP config."
            : "Target manifest removes this solely owned MCP declaration.",
        currentDigest: current.configDigest,
      });
    }

    const currentCron = new Map(record.cronJobs.map((cron) => [cron.manifestId, cron] as const));
    for (const target of params.targetManifest.cronJobs) {
      const current = currentCron.get(target.id);
      const desiredDigest = digest(target);
      const unresolved = current && (current.status !== "complete" || !current.schedulerJobId);
      const action = !current
        ? "add"
        : unresolved
          ? "manual"
          : digest(current.job) === desiredDigest
            ? "unchanged"
            : "change";
      actions.push({
        kind: "cronJob",
        id: target.id,
        action,
        target: current?.schedulerJobId ?? `claw:${agentId}:${target.id}`,
        blocked: action === "manual",
        reason:
          action === "manual"
            ? "Cron ownership is unresolved and must be reconciled with the gateway."
            : action === "unchanged"
              ? "Recorded cron declaration already matches the target manifest."
              : `Target manifest ${action === "add" ? "adds" : "changes"} this cron declaration.`,
        ...(current ? { currentDigest: digest(current.job) } : {}),
        desiredDigest,
      });
    }
    for (const current of record.cronJobs) {
      if (params.targetManifest.cronJobs.some((cron) => cron.id === current.manifestId)) {
        continue;
      }
      const manual = current.status !== "complete" || !current.schedulerJobId;
      actions.push({
        kind: "cronJob",
        id: current.manifestId,
        action: manual ? "manual" : "remove",
        target: current.schedulerJobId ?? current.declarationKey,
        blocked: manual,
        reason: manual
          ? "Target removes this cron declaration, but scheduler ownership is unresolved."
          : "Target manifest removes this owned cron declaration.",
        currentDigest: digest(current.job),
      });
    }

    actions.sort((left, right) =>
      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
    );
    const plan: Omit<ClawUpdatePlan, "planIntegrity"> = {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: true,
      mutationAllowed: false,
      found: true,
      agentId,
      currentClaw: {
        name: record.install.claw.name,
        version: record.install.claw.version,
        integrity: record.install.claw.integrity,
      },
      targetClaw: {
        name: params.targetSource.name,
        version: params.targetSource.version,
        integrity: params.targetSource.integrity,
      },
      summary: summarize(actions),
      actions,
      blockers,
      diagnostics: params.diagnostics ?? [],
    };
    return { ...plan, planIntegrity: digest(plan) };
  } finally {
    if (ownsDatabase) {
      database.walMaintenance.close();
    }
  }
}
