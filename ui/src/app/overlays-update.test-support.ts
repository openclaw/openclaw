import { vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import type { RequestFn } from "./overlays-access.test-support.ts";
import type { ApplicationUpdateOverlaySnapshot } from "./overlays-types.ts";
import { AUTO_UPDATE_SCHEDULE } from "./overlays-update-campaign.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

type Schedule = NonNullable<ApplicationUpdateOverlaySnapshot["updateSchedule"]>;
export function automaticSchedule(campaign: Partial<NonNullable<Schedule["campaign"]>>) {
  return { ...AUTO_UPDATE_SCHEDULE, campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, ...campaign } };
}

const overlays = new Set<ReturnType<typeof createApplicationOverlays>>();

export function createTestOverlays(...args: Parameters<typeof createApplicationOverlays>) {
  const instance = createApplicationOverlays(...args);
  overlays.add(instance);
  return instance;
}

export function disposeTestOverlays() {
  for (const instance of overlays) {
    instance.dispose();
  }
  overlays.clear();
}

export function updateStatusRequest(respond: (refreshCheckout: boolean) => unknown) {
  return vi.fn<RequestFn>((method, params) =>
    method === "update.status"
      ? Promise.resolve(respond(Boolean((params as { refreshCheckout?: boolean }).refreshCheckout)))
      : Promise.resolve({}),
  );
}

export function updateHello(
  schedule?: ApplicationUpdateOverlaySnapshot["updateSchedule"],
  scope = "operator.admin",
): ApplicationGatewaySnapshot["hello"] {
  return {
    auth: { role: "operator", scopes: [scope] },
    ...(schedule === undefined ? {} : { snapshot: { updateSchedule: schedule } }),
  } as ApplicationGatewaySnapshot["hello"];
}
