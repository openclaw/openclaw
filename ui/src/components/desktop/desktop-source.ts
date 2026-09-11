import type {
  DesktopSource,
  EnvironmentSummary,
  EnvironmentsListResult,
} from "@openclaw/gateway-protocol";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";

async function requestDesktopEnvironments(
  client: Pick<GatewayBrowserClient, "request">,
  sessionTarget: string | null | undefined,
): Promise<EnvironmentSummary[]> {
  // A session without placement has no desktop; only the global picker needs full inventory.
  if (sessionTarget === null) {
    return [];
  }
  if (sessionTarget !== undefined) {
    try {
      return [
        await client.request<EnvironmentSummary>("environments.status", {
          environmentId: sessionTarget,
        }),
      ];
    } catch (error) {
      if (
        error instanceof GatewayRequestError &&
        error.code === "INVALID_REQUEST" &&
        error.message === "unknown environmentId"
      ) {
        return [];
      }
      throw error;
    }
  }
  return (await client.request<EnvironmentsListResult>("environments.list", {})).environments;
}

export async function loadDesktopEnvironments(
  client: Pick<GatewayBrowserClient, "request">,
  options: {
    target: Promise<string | null | undefined>;
    isCurrent: () => boolean;
    recoverToPicker: boolean;
  },
): Promise<{ environments: EnvironmentSummary[]; selectedSource: string | undefined } | undefined> {
  const selectedTarget = await options.target;
  if (!options.isCurrent()) {
    return undefined;
  }
  let environments = await requestDesktopEnvironments(client, selectedTarget);
  if (!options.isCurrent()) {
    return undefined;
  }
  if (
    options.recoverToPicker &&
    selectedTarget !== undefined &&
    !environments.some((environment) => environment.id === selectedTarget && environment.desktop)
  ) {
    // Only a proven unavailable target enters the document's existing picker recovery.
    environments = await requestDesktopEnvironments(client, undefined);
    if (!options.isCurrent()) {
      return undefined;
    }
  }
  return {
    selectedSource: environments.find(
      (environment) => environment.id === selectedTarget && environment.desktop === true,
    )?.id,
    environments: environments.filter((environment) => environment.desktop === true),
  };
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
