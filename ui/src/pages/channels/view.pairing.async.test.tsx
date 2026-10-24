/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChannelsPairingListResult } from "../../api/types.ts";
import { hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { pairingRequest, pairingSnapshot } from "./pairing.test-support.ts";
import { renderChannelPairingQueue as PairingQueue } from "./view.pairing.tsx";
import { createChannelsViewProps } from "./view.test-support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  document.body.replaceChildren();
});

function mountQueue(request: (method: string) => unknown) {
  const client = createTestGatewayClient(request);
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["channels.pairing.list"], ["operator.pairing"]),
  });
  const channels = createChannelCapability(fixture.gateway);
  const approve = vi.fn();
  const mounted = mountSolid(() => {
    const source = projectChannels(channels);
    const connection = projectGateway(fixture.gateway);
    const props = createChannelsViewProps(null, null, { onPairingApprove: approve });
    return (
      <PairingQueue
        {...props}
        channels={source.read()}
        canManagePairing={hasOperatorPairingAccess(connection.read().snapshot.hello?.auth ?? null)}
      />
    );
  });
  cleanups.push(() => {
    mounted.unmount();
    channels.dispose();
  });
  return { ...fixture, channels, approve, container: mounted.container };
}

it("loads pairing feedback without replacing cached sender controls on failure or recovery", async () => {
  const first = createDeferred<ChannelsPairingListResult>();
  const failedRefresh = createDeferred<ChannelsPairingListResult>();
  const recovery = createDeferred<ChannelsPairingListResult>();
  const request = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(failedRefresh.promise)
    .mockReturnValueOnce(recovery.promise);
  const f = mountQueue(request);
  const initial = f.channels.refreshPairing();
  await waitForSolid(() =>
    expect(f.container.querySelector(".settings-loading-skeleton")).not.toBeNull(),
  );
  expect(f.container.textContent).not.toContain("Alice");
  first.resolve(pairingSnapshot());
  await initial;
  await waitForSolid(() => expect(f.container.textContent).toContain("Alice"));
  const details = f.container.querySelector<HTMLDetailsElement>("details")!;
  const approve = f.container.querySelector<HTMLButtonElement>('button[aria-label^="Approve "]')!;
  details.open = true;
  approve.focus();

  const refresh = f.channels.refreshPairing();
  await waitForSolid(() => {
    expect(
      f.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.disabled,
    ).toBe(true);
    expect(f.container.querySelector(".settings-loading-skeleton")).toBeNull();
    expect(f.container.querySelector("details")).toBe(details);
  });
  failedRefresh.reject(new Error("Pairing refresh unavailable"));
  await refresh;
  await waitForSolid(() =>
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Pairing refresh unavailable",
    ),
  );
  expect(f.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(f.container.contains(approve)).toBe(true);
  expect(document.activeElement).toBe(approve);

  const recovered = f.channels.refreshPairing();
  const updated = { ...pairingRequest, metadata: { name: "Alice Updated" } };
  recovery.resolve(pairingSnapshot({ requests: [updated] }));
  await recovered;
  await waitForSolid(() => {
    expect(details.textContent).toContain("Alice Updated");
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
  });
  expect(f.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(f.container.contains(approve)).toBe(true);
  expect(document.activeElement).toBe(approve);
  approve.click();
  expect(f.approve).toHaveBeenLastCalledWith(updated);
  expect(request).toHaveBeenCalledTimes(3);
});

it("recovers an initial read failure and hides a retired retry after pairing access changes", async () => {
  const failure = createDeferred<ChannelsPairingListResult>();
  const retired = createDeferred<ChannelsPairingListResult>();
  const recovery = createDeferred<ChannelsPairingListResult>();
  const request = vi
    .fn()
    .mockReturnValueOnce(failure.promise)
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(recovery.promise);
  const f = mountQueue(request);
  const initial = f.channels.refreshPairing();
  failure.reject(new Error("First read failed"));
  await initial;
  await waitForSolid(() =>
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain("First read failed"),
  );
  const retry = f.channels.refreshPairing();
  await waitForSolid(() => {
    expect(f.container.querySelector(".settings-loading-skeleton")).not.toBeNull();
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
  });
  f.publish({
    ...f.gateway.snapshot,
    hello: gatewayHelloForMethods(["channels.pairing.list"], []),
  });
  await waitForSolid(() => {
    expect(f.container.textContent).toContain("operator.pairing access");
    expect(f.container.querySelector(".settings-loading-skeleton")).toBeNull();
  });
  retired.resolve(pairingSnapshot());
  await retry;
  expect(f.container.textContent).not.toContain("Alice");
  f.publish({
    ...f.gateway.snapshot,
    hello: gatewayHelloForMethods(["channels.pairing.list"], ["operator.pairing"]),
  });
  const refresh = f.channels.refreshPairing();
  recovery.resolve(pairingSnapshot());
  await refresh;
  await waitForSolid(() => {
    expect(f.container.textContent).toContain("Alice");
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
  });
});
