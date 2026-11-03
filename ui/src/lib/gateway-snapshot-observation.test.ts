import { expect, it, onTestFinished, vi } from "vitest";
import { subscribeGatewaySnapshot } from "./gateway-snapshot-observation.ts";
import { createGatewayHarness } from "./session-pull-requests.test-support.ts";

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
