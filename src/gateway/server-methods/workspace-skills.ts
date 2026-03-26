import { logActivity } from "../../orchestration/activity-log-sqlite.js";
import * as WorkspaceSkillStore from "../../orchestration/workspace-skills-sqlite.js";
import type {
  WorkspaceSkillCompatibility,
  WorkspaceSkillFileInventoryEntry,
  WorkspaceSkillSourceType,
  WorkspaceSkillTrustLevel,
} from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type WorkspaceSkillsListParams = { workspaceId: string };
type WorkspaceSkillsGetParams = { id: string };
type WorkspaceSkillsCreateParams = {
  workspaceId: string;
  key: string;
  slug: string;
  name: string;
  description?: string;
  markdown: string;
  sourceType: string;
  sourceLocator?: string;
  sourceRef?: string;
  trustLevel?: string;
  compatibility?: string;
  fileInventory?: WorkspaceSkillFileInventoryEntry[];
  metadata?: Record<string, unknown>;
};
type WorkspaceSkillsUpdateParams = {
  id: string;
  name?: string;
  description?: string;
  markdown?: string;
  sourceRef?: string;
  trustLevel?: string;
  compatibility?: string;
  fileInventory?: WorkspaceSkillFileInventoryEntry[];
  metadata?: Record<string, unknown>;
};
type WorkspaceSkillsDeleteParams = { id: string };

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const workspaceSkillsHandlers: GatewayRequestHandlers = {
  "workspaceSkills.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkspaceSkillsListParams;
      const skills = WorkspaceSkillStore.listWorkspaceSkillsWithCounts(p.workspaceId);
      respond(true, { skills });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaceSkills.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkspaceSkillsGetParams;
      const skill = WorkspaceSkillStore.getWorkspaceSkill(p.id);
      if (!skill) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Workspace skill not found"));
        return;
      }
      respond(true, skill);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaceSkills.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkspaceSkillsCreateParams;
      const skill = WorkspaceSkillStore.createWorkspaceSkill({
        workspaceId: p.workspaceId,
        key: p.key,
        slug: p.slug,
        name: p.name,
        description: p.description,
        markdown: p.markdown,
        sourceType: p.sourceType as WorkspaceSkillSourceType,
        sourceLocator: p.sourceLocator,
        sourceRef: p.sourceRef,
        trustLevel: p.trustLevel as WorkspaceSkillTrustLevel | undefined,
        compatibility: p.compatibility as WorkspaceSkillCompatibility | undefined,
        fileInventory: p.fileInventory,
        metadata: p.metadata,
      });
      logActivity({
        workspaceId: p.workspaceId,
        entityType: "workspace_skill",
        entityId: skill.id,
        action: "created",
        details: { name: skill.name, key: skill.key },
      });
      respond(true, skill);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaceSkills.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkspaceSkillsUpdateParams;
      const existing = WorkspaceSkillStore.getWorkspaceSkill(p.id);
      if (!existing) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Workspace skill not found"));
        return;
      }
      const updated = WorkspaceSkillStore.updateWorkspaceSkill(p.id, {
        name: p.name,
        description: p.description,
        markdown: p.markdown,
        sourceRef: p.sourceRef,
        trustLevel: p.trustLevel as WorkspaceSkillTrustLevel | undefined,
        compatibility: p.compatibility as WorkspaceSkillCompatibility | undefined,
        fileInventory: p.fileInventory,
        metadata: p.metadata,
      });
      logActivity({
        workspaceId: existing.workspaceId,
        entityType: "workspace_skill",
        entityId: p.id,
        action: "updated",
        details: { name: existing.name },
      });
      respond(true, updated);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaceSkills.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkspaceSkillsDeleteParams;
      const existing = WorkspaceSkillStore.getWorkspaceSkill(p.id);
      WorkspaceSkillStore.deleteWorkspaceSkill(p.id);
      if (existing) {
        logActivity({
          workspaceId: existing.workspaceId,
          entityType: "workspace_skill",
          entityId: p.id,
          action: "deleted",
          details: { name: existing.name },
        });
      }
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
