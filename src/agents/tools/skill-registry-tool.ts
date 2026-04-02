import { Type } from "@sinclair/typebox";
import { loadControlPlaneRuntimeState } from "../../gateway/control-plane-runtime.js";
import { installSkillPackageFromRegistryDownload } from "../../gateway/control-plane-skill-install.js";
import {
  buildRuntimeAgentContext,
  recommendSkillsFromControlPlane,
  requestControlPlaneJson,
} from "../../gateway/control-plane-skill-registry.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";

const SkillRegistrySearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

const SkillRegistryInstallToolSchema = Type.Object({
  skillKey: Type.Optional(Type.String({ minLength: 1 })),
  version: Type.Optional(Type.String({ minLength: 1 })),
  versionId: Type.Optional(Type.String({ minLength: 1 })),
});

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createSkillRegistrySearchTool(): AnyAgentTool {
  return {
    label: "Skill Registry Search",
    name: "skill_registry_search",
    description:
      "Search and recommend published skills from the control-plane skill registry for the current training request.",
    parameters: SkillRegistrySearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 5;
      const data = await recommendSkillsFromControlPlane({
        query,
        limit,
        agentContext: buildRuntimeAgentContext(),
      });

      return jsonResult({
        ok: true,
        query,
        count: typeof data.count === "number" ? data.count : 0,
        items: Array.isArray(data.items) ? data.items : [],
      });
    },
  };
}

export function createSkillRegistryInstallTool(opts?: { workspaceDir?: string }): AnyAgentTool {
  return {
    label: "Skill Registry Install",
    name: "skill_registry_install",
    description:
      "Install a published skill version from the control-plane skill registry into the current agent workspace after user confirmation.",
    parameters: SkillRegistryInstallToolSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const versionId = readStringParam(params, "versionId");
      const skillKey = readStringParam(params, "skillKey");
      const version = readStringParam(params, "version");
      if (!versionId && (!skillKey || !version)) {
        throw new ToolInputError("versionId or skillKey + version required");
      }
      const workspaceDir = opts?.workspaceDir?.trim();
      if (!workspaceDir) {
        throw new Error("workspaceDir is required for skill installation");
      }

      const runtimeState = loadControlPlaneRuntimeState();
      const ticket = await requestControlPlaneJson("/api/skill-registry/runtime/install-ticket", {
        ...(versionId ? { versionId } : { skillKey, version }),
        remoteAgentId: runtimeState.remoteAgentId ?? undefined,
        managedMachineId: runtimeState.instanceId ?? runtimeState.instanceKey ?? undefined,
        correlationId: toolCallId,
        issuedTo: "openclaw-training-agent",
        reason: "portal training skill install",
      });

      const downloadUrl =
        typeof ticket.downloadUrl === "string" && ticket.downloadUrl.trim()
          ? ticket.downloadUrl.trim()
          : undefined;
      const resolvedSkillKey =
        (typeof ticket.skillKey === "string" && ticket.skillKey.trim()
          ? ticket.skillKey.trim()
          : undefined) ?? skillKey;
      if (!downloadUrl || !resolvedSkillKey) {
        throw new Error("install ticket is missing downloadUrl or skillKey");
      }

      const artifact = isJsonObject(ticket.artifact) ? ticket.artifact : {};
      const installResult = await installSkillPackageFromRegistryDownload({
        workspaceDir,
        downloadUrl,
        skillKey: resolvedSkillKey,
        artifactFormat:
          typeof artifact.format === "string" && artifact.format.trim()
            ? artifact.format.trim()
            : undefined,
        expectedSha256:
          typeof artifact.sha256 === "string" && artifact.sha256.trim()
            ? artifact.sha256.trim()
            : undefined,
      });
      if (!installResult.ok) {
        throw new Error(installResult.message);
      }

      return jsonResult({
        ok: true,
        skillKey: installResult.skillKey,
        version:
          typeof ticket.version === "string" && ticket.version.trim()
            ? ticket.version.trim()
            : null,
        installedPath: installResult.installedPath,
        bytes: installResult.bytes,
        sha256: installResult.sha256 ?? null,
        ticketId: typeof ticket.ticketId === "string" ? ticket.ticketId : null,
      });
    },
  };
}
