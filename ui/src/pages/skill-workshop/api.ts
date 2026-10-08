import type {
  SkillsWorkshopChangesResult,
  SkillsWorkshopListResult,
  SkillWorkshopChange,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type WorkshopSnapshot = {
  list: SkillsWorkshopListResult;
  changes: SkillWorkshopChange[];
};

const CHANGE_FEED_LIMIT = 50;

export async function loadWorkshopSnapshot(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<WorkshopSnapshot> {
  const [list, { changes }] = await Promise.all([
    client.request<SkillsWorkshopListResult>("skills.workshop.list", { agentId }),
    client.request<SkillsWorkshopChangesResult>("skills.workshop.changes", {
      agentId,
      limit: CHANGE_FEED_LIMIT,
    }),
  ]);
  return { list, changes };
}

export type WorkshopMutation =
  | { method: "skills.workshop.archive"; name: string }
  | { method: "skills.workshop.restore"; name: string; versionId?: string };

/**
 * Undo reverts to the version saved before the change. A creation, or a restore of an archived
 * skill, had no live copy to save, so its undo archives. Changes outlive pruned versions, so a
 * change whose version is no longer retained offers no undo.
 */
export function undoMutationFor(
  change: SkillWorkshopChange,
  list: SkillsWorkshopListResult,
): WorkshopMutation | null {
  const { skillName: name, versionId } = change;
  if (!versionId) {
    return change.action === "create" || change.action === "restore"
      ? { method: "skills.workshop.archive", name }
      : null;
  }
  const retained = list.archived
    .find((skill) => skill.name === name)
    ?.versions.some((version) => version.id === versionId);
  return retained ? { method: "skills.workshop.restore", name, versionId } : null;
}
