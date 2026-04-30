import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { NodeSession } from "../node-registry.js";
import {
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateEnvironmentsListParams,
  validateEnvironmentsStatusParams,
} from "../protocol/index.js";
import { respondInvalidParams, uniqueSortedStrings } from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

const LOCAL_ENVIRONMENT_CAPABILITIES = [
  "agent.run",
  "approvals",
  "models",
  "sessions",
  "tools.catalog",
  "tools.effective",
];

const GATEWAY_ENVIRONMENT_CAPABILITIES = [
  "gateway.events",
  "gateway.identity",
  "gateway.rpc",
  "node.discovery",
];

const MANAGED_TESTBOX_ENVIRONMENT_ID = "managed:testbox";

function withOptionalLabel(
  summary: Omit<EnvironmentSummary, "label"> & { label?: string | undefined },
): EnvironmentSummary {
  const label = normalizeOptionalString(summary.label);
  if (!label) {
    const withoutLabel: EnvironmentSummary = {
      id: summary.id,
      type: summary.type,
      status: summary.status,
    };
    if (summary.capabilities) {
      withoutLabel.capabilities = summary.capabilities;
    }
    return withoutLabel;
  }
  return { ...summary, label };
}

function nodeEnvironmentSummary(node: NodeSession): EnvironmentSummary {
  const label =
    normalizeOptionalString(node.displayName) ??
    normalizeOptionalString(node.clientId) ??
    normalizeOptionalString(node.nodeId);
  const commandCapabilities = node.commands.map((command) => `command:${command}`);
  return withOptionalLabel({
    id: `node:${node.nodeId}`,
    type: "node",
    label,
    status: "available",
    capabilities: uniqueSortedStrings(["node.invoke", ...node.caps, ...commandCapabilities]),
  });
}

export function listEnvironmentSummaries(nodes: readonly NodeSession[]): EnvironmentSummary[] {
  return [
    {
      id: "local",
      type: "local",
      label: "Local Gateway host",
      status: "available",
      capabilities: [...LOCAL_ENVIRONMENT_CAPABILITIES],
    },
    {
      id: "gateway",
      type: "gateway",
      label: "Current Gateway",
      status: "available",
      capabilities: [...GATEWAY_ENVIRONMENT_CAPABILITIES],
    },
    ...nodes
      .toSorted((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map(nodeEnvironmentSummary),
    {
      id: MANAGED_TESTBOX_ENVIRONMENT_ID,
      type: "managed",
      label: "Managed Testbox",
      status: "unavailable",
      capabilities: [],
    },
  ];
}

export const environmentsHandlers: GatewayRequestHandlers = {
  "environments.list": ({ params, respond, context }) => {
    if (!validateEnvironmentsListParams(params)) {
      respondInvalidParams({
        respond,
        method: "environments.list",
        validator: validateEnvironmentsListParams,
      });
      return;
    }
    respond(true, { environments: listEnvironmentSummaries(context.nodeRegistry.listConnected()) });
  },
  "environments.status": ({ params, respond, context }) => {
    if (!validateEnvironmentsStatusParams(params)) {
      respondInvalidParams({
        respond,
        method: "environments.status",
        validator: validateEnvironmentsStatusParams,
      });
      return;
    }
    const environmentId = normalizeOptionalString(params.environmentId);
    if (!environmentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "environmentId required"));
      return;
    }
    const environment =
      listEnvironmentSummaries(context.nodeRegistry.listConnected()).find(
        (candidate) => candidate.id === environmentId,
      ) ?? undefined;
    if (!environment) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"));
      return;
    }
    respond(true, environment);
  },
};
