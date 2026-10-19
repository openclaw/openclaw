import { vi } from "vitest";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

export type AsyncRequest = (...args: Parameters<GatewayRequestHandler>) => Promise<unknown>;
export function deviceFixture(
  id: string,
  label?: string,
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return {
    id: `node:${id}`,
    type: "node",
    label,
    status: "available",
    sessionHost: true,
    workerSlots: { total: 1, available: 1 },
    ...overrides,
  };
}

export function createPlacementPane(
  dialogs: ReturnType<typeof createModalDialogTestFixture>,
  handler: AsyncRequest = async () => ({ ok: true }),
  scopes = ["operator.read", "operator.write"],
  methods = ["sessions.move"],
) {
  const request = dialogs.mockRequest(handler);
  const reconcileMutation = vi.fn<SessionCapability["reconcileMutation"]>(async () => ({
    status: "refreshed",
  }));
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture({ reconcileMutation }),
  });
  fixture.pane.context.gateway.snapshot.hello = gatewayHelloForMethods(methods, scopes);
  return { ...fixture, request, reconcileMutation };
}
