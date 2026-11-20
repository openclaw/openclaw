import { createSignal } from "solid-js";
import { vi } from "vitest";
import type {
  AutomationCreationCardPlan,
  AutomationCreationRow,
} from "../../../lib/chat/automation-creation-card.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../../test-helpers/application-context-fixtures.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { createContext } from "../../cron/cron-page.test-support.tsx";
import { ChatCreatedAutomations } from "./chat-created-automations.tsx";

export function mountPlan(
  rows: AutomationCreationRow[],
  handler: GatewayRequestHandler,
  scopes = ["operator.admin"],
) {
  const [plan, setPlan] = createSignal<AutomationCreationCardPlan>({ planId: "plan", rows });
  const request = vi.fn(handler);
  const client = createTestGatewayClient(request);
  const source = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(["cron.get", "cron.update"], scopes),
    }),
  );
  const context = createContext(source.gateway);
  const wrapper = createSolidApplicationContextProvider(context).wrapper;
  const render = () => mountSolid(() => <ChatCreatedAutomations plan={plan()} />, { wrapper });
  const invalidate = () => source.publishEvent({ type: "event", event: "cron.inventory.changed" });
  return { ...render(), render, setPlan, request, context, source, invalidate };
}
