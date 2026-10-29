/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
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
import { channelSnapshot, createChannelsViewProps } from "./view.test-support.ts";
import { ChannelsView } from "./view.tsx";

function mountChannels(reads: { promise: Promise<unknown> }[], pairing = false) {
  const request = vi.fn();
  for (const read of reads) {
    request.mockReturnValueOnce(read.promise);
  }
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: gatewayHelloForMethods(
      [pairing ? "channels.pairing.list" : "channels.status"],
      [pairing ? "operator.pairing" : "operator.read"],
    ),
  });
  const channels = createChannelCapability(fixture.gateway);
  const approve = vi.fn();
  const mounted = mountSolid(() => {
    const source = projectChannels(channels);
    const connection = projectGateway(fixture.gateway);
    const [selected, setSelected] = createSignal<string | null>(null);
    return (
      <ChannelsView
        {...createChannelsViewProps(null, null)}
        channels={source.read()}
        canManagePairing={hasOperatorPairingAccess(connection.read().snapshot.hello?.auth ?? null)}
        selectedChannel={selected()}
        onShowDetail={setSelected}
        onCloseDetail={() => setSelected(null)}
        onRefresh={(probe) => void channels.refresh(probe)}
        onPairingApprove={approve}
      />
    );
  });
  onTestFinished(() => {
    mounted.unmount();
    channels.dispose();
    document.body.replaceChildren();
  });
  const container = pairing
    ? mounted.container.querySelector<HTMLElement>("#channels-pairing-requests")!
    : mounted.container;
  return { ...fixture, channels, approve, container };
}

function snapshot(label: string, partial = false): ChannelsStatusSnapshot {
  return channelSnapshot(
    { slack: { configured: true, running: true, connected: true } },
    {
      channelLabels: { slack: label },
      partial,
      warnings: partial ? ["Slack probe unavailable"] : [],
    },
  );
}

it.each([false, true])(
  "retains channels through failure and retry (cached: %s)",
  async (cached) => {
    const seed = createDeferred<ChannelsStatusSnapshot>();
    const failure = createDeferred<ChannelsStatusSnapshot>();
    const recovery = createDeferred<ChannelsStatusSnapshot>();
    const f = mountChannels(cached ? [seed, failure, recovery] : [failure, recovery]);
    let card: HTMLButtonElement | undefined;
    let dialog: HTMLElement | null = null;
    if (cached) {
      const initial = f.channels.refresh();
      seed.resolve(snapshot("Slack", true));
      await initial;
      await waitForSolid(() =>
        expect(f.container.textContent).toContain("Slack probe unavailable"),
      );
      card = Array.from(
        f.container.querySelectorAll<HTMLButtonElement>("button.channels-item"),
      ).find((button) => button.textContent?.includes("Slack"))!;
      expect(card).toBeDefined();
      card.focus();
    }
    const failed = f.channels.refresh(cached);
    await waitForSolid(() => {
      expect(f.container.querySelector(".channels-item__detail")).not.toBeNull();
      expect(f.container.querySelector(".settings-loading-skeleton")).toBeNull();
      if (cached) {
        expect(f.container.querySelector(".callout.info")).not.toBeNull();
        expect(document.activeElement).toBe(card);
      }
    });
    const recommended = f.container.querySelector(".channels-item__detail");
    failure.reject(new Error("Status unavailable"));
    await failed;
    await waitForSolid(() =>
      expect(f.container.querySelector(".callout.danger")?.textContent).toBe("Status unavailable"),
    );
    if (card) {
      expect(document.activeElement).toBe(card);
      card.click();
      await waitForSolid(() =>
        expect(f.container.querySelector("openclaw-modal-dialog")).not.toBeNull(),
      );
      dialog = f.container.querySelector("openclaw-modal-dialog");
    }
    const recovered = f.channels.refresh();
    await waitForSolid(() => {
      expect(f.container.querySelector(".callout.danger")?.textContent).toBe("Status unavailable");
      if (cached) {
        expect(
          Array.from(f.container.querySelectorAll(".callout"), (node) => node.className).slice(
            0,
            3,
          ),
        ).toEqual(["callout info", "callout warn", "callout danger"]);
        expect(f.container.querySelector(".callout.warn")?.textContent).toContain(
          "Slack probe unavailable",
        );
        expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
      } else {
        expect(f.container.querySelector(".callout.info")).toBeNull();
        expect(f.container.querySelector(".settings-loading-skeleton")).toBeNull();
        expect(f.container.querySelector(".channels-item__detail")).toBe(recommended);
      }
    });
    recovery.resolve(snapshot("Slack recovered"));
    await recovered;
    await waitForSolid(() => {
      expect(f.container.querySelector(".callout.danger")).toBeNull();
      expect(f.container.textContent).not.toContain("Slack probe unavailable");
      if (card) {
        expect(card.textContent).toContain("Slack recovered");
      }
    });
    if (card) {
      expect(f.container.contains(card)).toBe(true);
      expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
    } else {
      expect(f.container.querySelector(".channels-item__detail")).toBe(recommended);
    }
  },
);

it("loads pairing feedback without replacing cached sender controls on failure or recovery", async () => {
  const first = createDeferred<ChannelsPairingListResult>();
  const failedRefresh = createDeferred<ChannelsPairingListResult>();
  const recovery = createDeferred<ChannelsPairingListResult>();
  const f = mountChannels([first, failedRefresh, recovery], true);
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
  const expectRetained = () => {
    expect(f.container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(approve);
  };
  expectRetained();

  const recovered = f.channels.refreshPairing();
  const updated = { ...pairingRequest, metadata: { name: "Alice Updated" } };
  recovery.resolve(pairingSnapshot({ requests: [updated] }));
  await recovered;
  await waitForSolid(() => {
    expect(details.textContent).toContain("Alice Updated");
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
  });
  expectRetained();
  approve.click();
  expect(f.approve).toHaveBeenLastCalledWith(updated);
});

it("recovers an initial read failure and hides a retired retry after pairing access changes", async () => {
  const failure = createDeferred<ChannelsPairingListResult>();
  const retired = createDeferred<ChannelsPairingListResult>();
  const recovery = createDeferred<ChannelsPairingListResult>();
  const f = mountChannels([failure, retired, recovery], true);
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
