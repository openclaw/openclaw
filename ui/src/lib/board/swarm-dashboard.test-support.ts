import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../sessions/index.ts";
import "./swarm-dashboard.ts";

const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.swarmDashboardTestApi")
] as
  | {
      hydrateSwarmSessionRows(params: {
        sessions: SessionCapability;
        parentKey: string;
        currentRows: readonly GatewaySessionRow[];
        isCurrent: () => boolean;
      }): Promise<GatewaySessionRow[] | null>;
      mergeSwarmSessionRows(
        childRows: readonly GatewaySessionRow[],
        currentRows: readonly GatewaySessionRow[],
      ): GatewaySessionRow[];
    }
  | undefined;

if (!testing) {
  throw new Error("Swarm dashboard test API is unavailable");
}

export const { hydrateSwarmSessionRows, mergeSwarmSessionRows } = testing;
