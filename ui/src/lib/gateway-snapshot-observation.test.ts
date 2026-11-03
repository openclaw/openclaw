import { expect, it, onTestFinished, vi } from "vitest";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";

const createHello = (scopes = ["operator.read"]) =>
  gatewayHelloForMethods(["controlUi.sessionPullRequests.subscribe"], scopes);
function createGatewayHarness() {
  const publication = createApplicationGateway(
    createApplicationGatewaySnapshot({
      phase: "connected",
      client: createTestGatewayClient(async () => ({ subscribed: true })),
      hello: createHello(),
    }),
  );
  const subscribe = publication.gateway.subscribe;
  const unsubscribeSnapshots = vi.fn();
  const subscribeSnapshots = vi
    .spyOn(publication.gateway, "subscribe")
    .mockImplementation((listener) => {
      const stop = subscribe(listener);
      return () => {
        unsubscribeSnapshots();
        stop();
      };
    });
  return {
    ...publication,
    setSnapshot: publication.publish,
    subscribeSnapshots,
    unsubscribeSnapshots,
  };
}
import { subscribeGatewaySnapshot } from "./gateway-snapshot-observation.ts";

it("filters CI snapshots by the exact details and automation retirement facts", () => {
  const harness = createGatewayHarness();
  const gateway = harness.gateway;
  const client = gateway.snapshot.client!;
  let revision = gateway.connectionRevision;
  let generation = 1;
  Object.defineProperty(gateway, "connectionRevision", { get: () => revision });
  Object.defineProperty(client, "connectionGeneration", { get: () => generation });
  const detailsChanged = vi.fn();
  const automationChanged = vi.fn();
  const stops = [
    ...Array.from({ length: 100 }, () =>
      subscribeGatewaySnapshot(gateway, "connection", detailsChanged),
    ),
    ...Array.from({ length: 200 }, () =>
      subscribeGatewaySnapshot(gateway, "authority", automationChanged),
    ),
  ];
  onTestFinished(() => stops.forEach((stop) => stop()));
  expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
  harness.setSnapshot({ ...gateway.snapshot, lastError: "Unrelated", sessionKey: "other" });
  expect(detailsChanged).not.toHaveBeenCalled();
  expect(automationChanged).not.toHaveBeenCalled();

  for (const change of [
    () => {
      revision += 1;
    },
    () => {
      generation += 1;
    },
    () => harness.setSnapshot({ ...gateway.snapshot, hello: createHello(["operator.admin"]) }),
  ]) {
    change();
    harness.setSnapshot({ ...gateway.snapshot });
    expect(detailsChanged).not.toHaveBeenCalled();
    expect(automationChanged).toHaveBeenCalledTimes(200);
    automationChanged.mockClear();
  }
  harness.setSnapshot({ ...gateway.snapshot, phase: "offline" });
  expect(detailsChanged).toHaveBeenCalledTimes(100);
  expect(automationChanged).toHaveBeenCalledTimes(200);
  stops.forEach((stop) => stop());
  expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
});

it("finishes synchronous CI retirement after a nested snapshot and isolates callbacks", () => {
  const harness = createGatewayHarness();
  const gateway = harness.gateway;
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  let replaced = false;
  const stopFirst = subscribeGatewaySnapshot(gateway, "connection", () => {
    if (!replaced) {
      replaced = true;
      harness.setSnapshot({ ...gateway.snapshot, lastError: "Nested publication" });
    }
  });
  const stopThrowing = subscribeGatewaySnapshot(gateway, "authority", () => {
    throw new Error("Automation refresh failed");
  });
  const notify = vi.fn();
  const stopLast = subscribeGatewaySnapshot(gateway, "authority", notify);
  onTestFinished(() => {
    stopFirst();
    stopThrowing();
    stopLast();
    vi.unstubAllGlobals();
  });
  harness.setSnapshot({ ...gateway.snapshot, phase: "offline" });
  expect(notify).toHaveBeenCalledExactlyOnceWith(gateway.snapshot);
  expect(report).toHaveBeenCalledOnce();
});

it("notifies authority observers for handshake identity and in-place method changes only", () => {
  const harness = createGatewayHarness();
  const authority = vi.fn();
  const connection = vi.fn();
  const stopAuthority = subscribeGatewaySnapshot(harness.gateway, "authority", authority);
  const stopConnection = subscribeGatewaySnapshot(harness.gateway, "connection", connection);
  onTestFinished(() => {
    stopAuthority();
    stopConnection();
  });
  expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
  const hello = harness.gateway.snapshot.hello!;
  harness.setSnapshot({ ...harness.gateway.snapshot, hello: { ...hello } });
  expect(authority).toHaveBeenCalledOnce();
  hello.features!.methods!.push("fixture.read");
  harness.setSnapshot({ ...harness.gateway.snapshot });
  expect(authority).toHaveBeenCalledTimes(2);
  harness.setSnapshot({ ...harness.gateway.snapshot, lastError: "Unrelated" });
  expect(authority).toHaveBeenCalledTimes(2);
  expect(connection).not.toHaveBeenCalled();
  stopAuthority();
  stopConnection();
  expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
});
