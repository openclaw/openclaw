import path from "node:path";
import type { ClawActionEffect } from "../../packages/gateway-protocol/src/schema/claws.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { digestClawValue } from "./digest.js";
import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";
import { digestClawMcpServer } from "./mcp.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { mcpServerSchema } from "./schema.js";
import type { ClawAddPlanAction } from "./types.js";
import type { ClawUpdateAction } from "./update-plan-types.js";

type OwnershipEffect = NonNullable<Extract<ClawActionEffect, { type: "mcp-server" }>["ownership"]>;
type SkillArtifact = NonNullable<Extract<ClawActionEffect, { type: "skill-package" }>["desired"]>;

function skillArtifact(details: Record<string, unknown> | undefined): SkillArtifact {
  const source = details?.source;
  const ref = details?.ref;
  const version = details?.version;
  const rawIntegrity = details?.integrity;
  const integrity =
    typeof rawIntegrity === "string" ? normalizeClawHubSha256Integrity(rawIntegrity) : null;
  if (
    source !== "clawhub" ||
    typeof ref !== "string" ||
    !ref ||
    typeof version !== "string" ||
    !version ||
    !integrity
  ) {
    throw new Error("Claw skill artifact cannot be disclosed.");
  }
  return { source, ref, version, integrity };
}

function assertSkillActionTarget(action: { id: string; target: string }, artifact: SkillArtifact) {
  if (
    action.id !== `skill:${artifact.ref}` ||
    action.target !== `${artifact.source}:${artifact.ref}@${artifact.version}`
  ) {
    throw new Error("Claw skill action does not match its artifact.");
  }
}

function workspaceDestination(id: string): string {
  if (!isSafeClawRelativePath(id)) {
    throw new Error("Claw workspace destination cannot be disclosed.");
  }
  return `workspace/${id.replaceAll("\\", "/")}`;
}

function sourceLabel(action: ClawAddPlanAction, sourceRoot: string): string {
  if (action.sourceKind === "clawMarkdownBody") {
    return "CLAW.md body";
  }
  if (!action.source) {
    throw new Error("Claw workspace source cannot be disclosed.");
  }
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(action.source));
  if (!isSafeClawRelativePath(relative)) {
    throw new Error("Claw workspace source cannot be disclosed.");
  }
  return `package/${relative.split(path.sep).join("/")}`;
}

function fileEffect(params: {
  id: string;
  source?: string;
  currentDigest?: string;
  desiredDigest?: string;
  currentPresent?: boolean;
}): ClawActionEffect {
  if (!params.currentDigest && !params.desiredDigest) {
    throw new Error("Claw workspace file digest cannot be disclosed.");
  }
  return {
    type: "workspace-file",
    destination: workspaceDestination(params.id),
    ...(params.source ? { source: params.source } : {}),
    ...(params.currentDigest ? { currentDigest: params.currentDigest } : {}),
    ...(params.desiredDigest ? { desiredDigest: params.desiredDigest } : {}),
    ...(params.currentPresent !== undefined ? { currentPresent: params.currentPresent } : {}),
  };
}

function mcpDeclaration(details: Record<string, unknown>) {
  const fields = [
    "command",
    "transport",
    "args",
    "env",
    "url",
    "auth",
    "toolFilter",
    "timeout",
    "connectTimeout",
  ] as const;
  const candidate = Object.fromEntries(
    fields.filter((field) => details[field] !== undefined).map((field) => [field, details[field]]),
  );
  const parsed = mcpServerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("Claw MCP declaration cannot be disclosed.");
  }
  const server = parsed.data;
  const common = {
    authentication:
      "auth" in server && server.auth === "oauth" ? ("oauth" as const) : ("none" as const),
    ...(server.toolFilter ? { toolFilter: server.toolFilter } : {}),
    ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
    ...(server.connectTimeout !== undefined ? { connectTimeout: server.connectTimeout } : {}),
  };
  if ("command" in server) {
    return {
      declaration: {
        transport: "stdio" as const,
        command: server.command,
        arguments: server.args ?? [],
        environment: Object.entries(server.env ?? {})
          .map(([name, value]) => ({ name, sourceName: value.slice(2, -1) }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        ...common,
      },
      digest: digestClawMcpServer(server),
    };
  }
  const safeUrl = new URL(server.url);
  const queryParameterNames = [...new Set(safeUrl.searchParams.keys())].toSorted();
  safeUrl.username = "";
  safeUrl.password = "";
  safeUrl.search = "";
  safeUrl.hash = "";
  return {
    declaration: {
      transport: server.transport,
      url: safeUrl.toString(),
      urlDigest: digestClawValue(server.url),
      ...(queryParameterNames.length ? { queryParameterNames } : {}),
      ...common,
    },
    digest: digestClawMcpServer(server),
  };
}

function ownership(details: Record<string, unknown> | undefined): OwnershipEffect {
  const relationship = details?.relationship;
  const origin = details?.origin;
  const independentOwner = details?.independentOwner;
  const affectedClawAgentIds = details?.affectedClawAgentIds;
  if (
    (relationship !== "managed" && relationship !== "referenced") ||
    (origin !== "claw-introduced" && origin !== "pre-existing") ||
    typeof independentOwner !== "boolean" ||
    !Array.isArray(affectedClawAgentIds) ||
    !affectedClawAgentIds.every((id: unknown) => typeof id === "string")
  ) {
    throw new Error("Claw resource ownership cannot be disclosed.");
  }
  return {
    relationship,
    origin,
    independentOwner,
    affectedClawCount: affectedClawAgentIds.length,
  };
}

export function clawActionNeedsEffect(
  operation: "add" | "update" | "remove",
  action: { kind: string; id: string },
): boolean {
  return (
    action.kind === "workspaceFile" ||
    action.kind === "bootstrap" ||
    action.kind === "mcpServer" ||
    (action.kind === "package" && action.id.startsWith("skill:")) ||
    (operation === "remove" && action.kind === "packageRef")
  );
}

export function projectClawAddActionEffect(
  action: ClawAddPlanAction,
  sourceRoot: string,
): ClawActionEffect | undefined {
  if (action.kind === "workspaceFile" || action.kind === "bootstrap") {
    return fileEffect({
      id: action.id,
      source: sourceLabel(action, sourceRoot),
      desiredDigest: action.digest,
    });
  }
  if (action.kind === "mcpServer") {
    const { declaration, digest } = mcpDeclaration(action.details ?? {});
    return { type: "mcp-server", desiredDigest: digest, proposed: declaration };
  }
  if (action.kind === "package" && action.id.startsWith("skill:")) {
    if (action.details?.kind !== "skill") {
      throw new Error("Claw skill package kind cannot be disclosed.");
    }
    const desired = skillArtifact(action.details);
    assertSkillActionTarget(action, desired);
    if (!action.digest || normalizeClawHubSha256Integrity(action.digest) !== desired.integrity) {
      throw new Error("Claw skill package integrity does not match its preflight.");
    }
    return { type: "skill-package", desired };
  }
  return undefined;
}

export function projectClawUpdateActionEffect(
  action: ClawUpdateAction,
  targetActions: readonly ClawAddPlanAction[],
  currentPackages: readonly PersistedClawPackageRef[],
  sourceRoot: string,
): ClawActionEffect | undefined {
  if (action.kind === "workspaceFile") {
    const target = targetActions.find(
      (candidate) => candidate.kind === "workspaceFile" && candidate.id === action.id,
    );
    if (action.desiredDigest && (!target || target.digest !== action.desiredDigest)) {
      throw new Error("Claw target workspace file cannot be disclosed.");
    }
    return fileEffect({
      id: action.id,
      ...(target && action.desiredDigest ? { source: sourceLabel(target, sourceRoot) } : {}),
      currentDigest: action.currentDigest,
      desiredDigest: action.desiredDigest,
      currentPresent: action.currentPresent,
    });
  }
  if (action.kind === "mcpServer") {
    const target = targetActions.find(
      (candidate) => candidate.kind === "mcpServer" && candidate.id === action.id,
    );
    if (action.desiredDigest) {
      if (!target) {
        throw new Error("Claw target MCP server cannot be disclosed.");
      }
      const { declaration, digest } = mcpDeclaration(target.details ?? {});
      if (digest !== action.desiredDigest) {
        throw new Error("Claw target MCP server changed before disclosure.");
      }
      return {
        type: "mcp-server",
        ...(action.currentDigest ? { currentDigest: action.currentDigest } : {}),
        desiredDigest: digest,
        proposed: declaration,
      };
    }
    if (!action.currentDigest) {
      throw new Error("Claw current MCP server cannot be disclosed.");
    }
    return { type: "mcp-server", currentDigest: action.currentDigest };
  }
  if (action.kind === "package" && action.id.startsWith("skill:")) {
    const currentRef = currentPackages.find(
      (candidate) => candidate.kind === "skill" && action.id === `skill:${candidate.ref}`,
    );
    if (
      Boolean(currentRef) !== Boolean(action.currentDigest) ||
      (currentRef && digestClawPackageRef(currentRef) !== action.currentDigest)
    ) {
      throw new Error("Claw current skill artifact changed before disclosure.");
    }
    const current = currentRef ? skillArtifact(currentRef) : undefined;
    if (action.action === "release") {
      if (!current) {
        throw new Error("Claw current skill artifact cannot be disclosed.");
      }
      assertSkillActionTarget(action, current);
      return { type: "skill-package", current };
    }
    const target = targetActions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    if (!target || target.details?.kind !== "skill" || target.target !== action.target) {
      throw new Error("Claw target skill artifact cannot be disclosed.");
    }
    const desired = skillArtifact(target.details);
    assertSkillActionTarget(action, desired);
    if (!target.digest || normalizeClawHubSha256Integrity(target.digest) !== desired.integrity) {
      throw new Error("Claw target skill integrity does not match its preflight.");
    }
    return { type: "skill-package", ...(current ? { current } : {}), desired };
  }
  return undefined;
}

export function projectClawRemoveActionEffect(
  action: ClawRemovePlanAction,
): ClawActionEffect | undefined {
  if (action.kind === "workspaceFile" || action.kind === "bootstrap") {
    return fileEffect({
      id: action.id,
      currentDigest:
        typeof action.details?.contentDigest === "string"
          ? action.details.contentDigest
          : undefined,
    });
  }
  if (action.kind === "packageRef") {
    if (action.id.startsWith("skill:")) {
      const current = skillArtifact(action.details);
      if (
        action.id !== `skill:${current.ref}@${current.version}` ||
        action.target !== `${current.source}:${current.ref}@${current.version}`
      ) {
        throw new Error("Claw removed skill does not match its artifact.");
      }
      return { type: "skill-package", current, ownership: ownership(action.details) };
    }
    return { type: "ownership", ...ownership(action.details) };
  }
  if (action.kind === "mcpServer") {
    if (typeof action.details?.configDigest !== "string") {
      throw new Error("Claw current MCP digest cannot be disclosed.");
    }
    return {
      type: "mcp-server",
      currentDigest: action.details.configDigest,
      ownership: ownership(action.details),
    };
  }
  return undefined;
}
