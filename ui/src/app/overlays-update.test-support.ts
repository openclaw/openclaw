import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, createGatewayHarness, type RequestFn } from "./overlays-access.test-support.ts";
import type { ApplicationUpdateOverlaySnapshot } from "./overlays-types.ts";
import {
  AUTO_UPDATE_SCHEDULE,
  createAutomaticUpdateHarness,
} from "./overlays-update-campaign.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

type Schedule = NonNullable<ApplicationUpdateOverlaySnapshot["updateSchedule"]>;
export function updateSentinel(reason: string, ts?: number, stats: object = {}) {
  return {
    kind: "update",
    status: "error",
    ...(ts === undefined ? {} : { ts }),
    stats: { reason, ...stats },
  };
}

export function campaignSchedule(
  overrides: Partial<NonNullable<Schedule["campaign"]>>,
  options: Pick<Schedule, "channel" | "target"> = { channel: "stable" },
): Schedule & { campaign: NonNullable<Schedule["campaign"]> } {
  return {
    autoEnabled: true,
    ...options,
    campaign: {
      id: "campaign-1",
      announcedAtMs: 1_000,
      forceAtMs: 901_000,
      updatedAtMs: 1_000,
      state: "countdown",
      ...overrides,
    },
  };
}

export function automaticSchedule(campaign: Partial<NonNullable<Schedule["campaign"]>>) {
  return { ...AUTO_UPDATE_SCHEDULE, campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, ...campaign } };
}

const overlays = new Set<ReturnType<typeof createApplicationOverlays>>();
const replies = new Set<() => void>();
const operations = new Set<Promise<unknown>>();

export function pendingReply<T>(fallback: T) {
  const reply = createDeferred<T>();
  replies.add(() => reply.resolve(fallback));
  return reply;
}

export function settleAtCleanup<T>(operation: Promise<T>) {
  operations.add(operation);
  return operation;
}

function createTestOverlays(...args: Parameters<typeof createApplicationOverlays>) {
  const instance = createApplicationOverlays(...args);
  overlays.add(instance);
  return instance;
}

export async function disposeTestOverlays() {
  for (const resolve of replies) {
    resolve();
  }
  replies.clear();
  for (const operation of operations) {
    await operation;
  }
  operations.clear();
  for (const instance of overlays) {
    instance.dispose();
  }
  overlays.clear();
}

export function updateFixture(
  harness: ReturnType<typeof createGatewayHarness>,
  hooks?: Parameters<typeof createApplicationOverlays>[1],
) {
  let instance = createTestOverlays(harness.gateway, hooks);
  return {
    harness,
    overlays: instance,
    expectState: (expected: object) => expect(instance.snapshot).toMatchObject(expected),
    remount: () => {
      instance.dispose();
      instance = createTestOverlays(harness.gateway, hooks);
      return instance;
    },
    reconnect: () => {
      harness.update({ phase: "reconnecting" });
      harness.update({ phase: "connected" });
    },
  };
}

export const automaticTest = (request: RequestFn) =>
  updateFixture(createAutomaticUpdateHarness(request));
export const runTest = (
  request: RequestFn,
  hooks?: Parameters<typeof createApplicationOverlays>[1],
) => updateFixture(updateRunHarness(request), hooks);
export function gatewayTest(request: RequestFn, hello?: ApplicationGatewaySnapshot["hello"]) {
  const harness = createGatewayHarness(client(request));
  if (hello !== undefined) {
    harness.update({ hello });
  }
  return updateFixture(harness);
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
