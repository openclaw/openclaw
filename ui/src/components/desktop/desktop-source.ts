import type {
  DesktopSource,
  EnvironmentSummary,
  EnvironmentsListResult,
} from "@openclaw/gateway-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";

export function resolveChatPaneDesktopTarget(
  session: GatewaySessionRow | undefined,
): string | null {
  if (!session) {
    return null;
  }
  const placement = session.placement;
  if (placement && placement.state !== "local") {
    // Wait for the active owner; starting or reclaimed sessions do not own a desktop yet.
    if (placement.state !== "active") {
      return null;
    }
    if (placement.runner?.kind === "device") {
      const nodeId = normalizeOptionalString(placement.runner.deviceId);
      return placement.runner.status === "available" && nodeId ? `node:${nodeId}` : null;
    }
    return normalizeOptionalString(placement.environmentId) ?? null;
  }
  const execNode = normalizeOptionalString(session.execNode);
  return execNode ? `node:${execNode}` : "gateway";
}

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
): Promise<
  | {
      environments: EnvironmentSummary[];
      selectedSource: string | undefined;
      pendingSource?: string;
      hostSetup?: EnvironmentSummary;
    }
  | undefined
> {
  const selectedTarget = await options.target;
  if (!options.isCurrent()) {
    return undefined;
  }
  let environments = await requestDesktopEnvironments(client, selectedTarget);
  if (!options.isCurrent()) {
    return undefined;
  }
  const selectedEnvironment = environments.find((environment) => environment.id === selectedTarget);
  if (selectedEnvironment?.status === "starting") {
    return {
      environments: [selectedEnvironment],
      selectedSource: undefined,
      pendingSource: selectedEnvironment.id,
    };
  }
  if (
    selectedEnvironment?.status === "error" ||
    (!options.recoverToPicker && selectedEnvironment && selectedEnvironment.status !== "available")
  ) {
    throw new Error(selectedEnvironment.worker?.error ?? "Desktop environment is unavailable");
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
  const selectedSource = environments.find(
    (environment) =>
      environment.id === selectedTarget &&
      environment.status === "available" &&
      environment.desktop === true,
  )?.id;
  let hostSetup: EnvironmentSummary | undefined;
  if (
    !options.recoverToPicker &&
    selectedTarget === "gateway" &&
    selectedSource === undefined &&
    selectedEnvironment?.status === "available"
  ) {
    // Host Desktop is off: ask what setup the host needs; a failed check keeps the generic notice.
    const listed = await client
      .request<EnvironmentsListResult>("environments.list", { includeDesktopSetup: true })
      .catch(() => undefined);
    if (!options.isCurrent()) {
      return undefined;
    }
    hostSetup = listed?.environments.find(
      (environment) => environment.id === "gateway" && environment.desktopSetup,
    );
  }
  return {
    selectedSource,
    environments: environments.filter((environment) => environment.desktop === true),
    ...(hostSetup ? { hostSetup } : {}),
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
