import { expect, vi } from "vitest";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
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

/** Select a displayed OS or machine through the native configuration menu. */
export async function selectPlacementConfiguration(label: string, value: string) {
  const trigger = document.body.querySelector<HTMLButtonElement>(
    `button[aria-haspopup="menu"][aria-label="${label}"]`,
  )!;
  expect(trigger).not.toBeNull();
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const choice = menu.querySelector<HTMLButtonElement>(
    `[role="menuitemradio"][data-value="${value}"]`,
  )!;
  expect(choice).not.toBeNull();
  choice.click();
  flush();
}
