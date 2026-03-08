import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  deriveNeighborEntityId,
  describeEntity,
  loadRelationshipGraphSnapshot,
  summarizeEdge,
} from "./relationship-common.js";

const RelationshipNeighborsSchema = Type.Object({
  entityId: Type.String(),
  direction: Type.Optional(Type.String()),
  edgeType: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
});

type Direction = "both" | "in" | "out";

function normalizeDirection(value: string | undefined): Direction {
  return value === "in" || value === "out" ? value : "both";
}

export function createRelationshipNeighborsTool(): AnyAgentTool {
  return {
    label: "Relationship Neighbors",
    name: "relationship_neighbors",
    description: "List neighboring entities for one local relationship-index entity.",
    parameters: RelationshipNeighborsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const entityId = readStringParam(params, "entityId", { required: true });
      const direction = normalizeDirection(readStringParam(params, "direction"));
      const edgeType = readStringParam(params, "edgeType");
      const limit = Math.max(
        1,
        Math.min(50, readNumberParam(params, "limit", { integer: true }) ?? 10),
      );
      const graph = await loadRelationshipGraphSnapshot();
      const edges = graph.edges.filter((edge) => {
        if (direction === "out" && edge.from !== entityId) {
          return false;
        }
        if (direction === "in" && edge.to !== entityId) {
          return false;
        }
        if (direction === "both" && edge.from !== entityId && edge.to !== entityId) {
          return false;
        }
        return !edgeType || edge.edgeType === edgeType;
      });

      return jsonResult({
        entityId,
        direction,
        neighbors: edges.slice(0, limit).map((edge) => {
          const neighborId = deriveNeighborEntityId(edge, entityId);
          return {
            edge: summarizeEdge(edge),
            neighbor: describeEntity(neighborId ? graph.nodes[neighborId] : undefined),
          };
        }),
      });
    },
  };
}
