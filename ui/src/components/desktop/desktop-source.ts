import type {
  DesktopSource,
  EnvironmentSummary,
  EnvironmentsListResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function loadDesktopEnvironments(
  client: Pick<GatewayBrowserClient, "request">,
  sessionTarget: string | null | undefined,
): Promise<EnvironmentSummary[]> {
  // A session without placement has no desktop; only the global picker needs full inventory.
  if (sessionTarget === null) {
    return [];
  }
  if (sessionTarget !== undefined) {
    return [
      await client.request<EnvironmentSummary>("environments.status", {
        environmentId: sessionTarget,
      }),
    ];
  }
  return (await client.request<EnvironmentsListResult>("environments.list", {})).environments;
}

export function desktopSourceForEnvironment(
  environment: Pick<EnvironmentSummary, "id">,
): DesktopSource {
  if (environment.id === "gateway") {
    return { kind: "host" };
  }
  if (environment.id.startsWith("node:") && environment.id.length > "node:".length) {
    return { kind: "node", nodeId: environment.id.slice("node:".length) };
  }
  return { kind: "environment", environmentId: environment.id };
}
