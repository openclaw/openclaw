import type {
  TemplateLifecyclePlanResult,
  TemplatesAddApplyParams,
  TemplatesAddPlanParams,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import { AsyncContext } from "../shared/async-context.js";
import type { GatewayTemplateAddApplyResult } from "../templates/gateway-add-apply.js";

/** Host-only capability; never serialized into model arguments or an MCP server. */
export type SystemAgentTemplateGateway = {
  review: (params: TemplatesAddPlanParams) => Promise<TemplateLifecyclePlanResult>;
  install: (
    params: TemplatesAddApplyParams,
    beforePersistentApply?: () => void,
  ) => Promise<GatewayTemplateAddApplyResult>;
};

const templateGateway = new AsyncContext<SystemAgentTemplateGateway | undefined>(
  Symbol("systemAgentTemplateGateway"),
);
export const withSystemAgentTemplateGateway = <T>(
  gateway: SystemAgentTemplateGateway | undefined,
  run: () => T,
): T => templateGateway.run(gateway, run);

export function getSystemAgentTemplateGateway(): SystemAgentTemplateGateway | undefined {
  return templateGateway.getStore();
}
