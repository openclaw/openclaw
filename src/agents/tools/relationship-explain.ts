import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadRelationshipGraphSnapshot, summarizeEdge } from "./relationship-common.js";

const RelationshipExplainSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  edgeType: Type.Optional(Type.String()),
});

export function createRelationshipExplainTool(): AnyAgentTool {
  return {
    label: "Relationship Explain",
    name: "relationship_explain",
    description: "Explain local relationship-index edges between two entities.",
    parameters: RelationshipExplainSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const from = readStringParam(params, "from", { required: true });
      const to = readStringParam(params, "to", { required: true });
      const edgeType = readStringParam(params, "edgeType");
      const graph = await loadRelationshipGraphSnapshot();
      const matches = graph.edges
        .filter((edge) => edge.from === from && edge.to === to)
        .filter((edge) => !edgeType || edge.edgeType === edgeType)
        .map((edge) => summarizeEdge(edge));
      return jsonResult({
        from,
        to,
        edgeType,
        matches,
      });
    },
  };
}
