import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { describeEntity, loadRelationshipGraphSnapshot } from "./relationship-common.js";

const RelationshipLookupSchema = Type.Object({
  entityId: Type.String(),
});

export function createRelationshipLookupTool(): AnyAgentTool {
  return {
    label: "Relationship Lookup",
    name: "relationship_lookup",
    description: "Look up one entity in the local relationship index.",
    parameters: RelationshipLookupSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const entityId = readStringParam(params, "entityId", { required: true });
      const graph = await loadRelationshipGraphSnapshot();
      const entity = describeEntity(graph.nodes[entityId]);
      const edgeCount = graph.edges.filter(
        (edge) => edge.from === entityId || edge.to === entityId,
      ).length;
      return jsonResult({
        entityId,
        found: Boolean(entity),
        entity,
        edgeCount,
      });
    },
  };
}
