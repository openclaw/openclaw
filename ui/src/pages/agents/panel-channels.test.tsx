/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AgentChannels } from "./panels-status-files.tsx";

function snapshot(): ChannelsStatusSnapshot {
  return {
    ts: 1,
    channelOrder: ["discord"],
    channelLabels: { discord: "Discord" },
    channels: {},
    channelAccounts: { discord: [{ accountId: "demo", connected: true, configured: true }] },
    channelDefaultAccountId: { discord: "demo" },
  };
}

it("retains cached channels through retry and retires feedback with the connection", async () => {
  const failed = createDeferred<ChannelsStatusSnapshot>();
  const recovered = createDeferred<ChannelsStatusSnapshot>();
  const invalidated = createDeferred<ChannelsStatusSnapshot>();
  const followup = createDeferred<ChannelsStatusSnapshot>();
  const retired = createDeferred<ChannelsStatusSnapshot>();
  const responses = [
    Promise.resolve(snapshot()),
    failed.promise,
    recovered.promise,
    invalidated.promise,
    followup.promise,
    retired.promise,
  ];
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    client: createTestGatewayClient(() => responses.shift()),
    phase: "connected",
    hello: gatewayHelloForMethods(["channels.status"], ["operator.read"]),
  });
  const channels = createChannelCapability(fixture.gateway);
  await channels.refresh();
  let pending: Promise<void> | undefined;
  const mounted = mountSolid(() => {
    const source = projectChannels(channels);
    return (
      <AgentChannels
        context={{
          workspace: "default",
          model: "—",
          runtime: "pi",
          identityName: "Main",
          identityAvatar: "—",
          skillsLabel: "all skills",
          isDefault: true,
        }}
        configForm={null}
        readState={source.read}
        onRefresh={() => {
          pending = channels.refresh();
        }}
        onSelectPanel={() => undefined}
      />
    );
  });
  const refresh = () =>
    Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.trim().startsWith("Refresh"),
    )!;
  const row = Array.from(mounted.container.querySelectorAll(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent === "Discord",
  );
  try {
    expect(row).toBeDefined();
    await waitForSolid(() => expect(refresh().disabled).toBe(false));
    refresh().click();
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(true);
      expect(refresh().textContent).toContain("Refreshing");
      expect(mounted.container.contains(row!)).toBe(true);
    });
    failed.reject(new Error("Synthetic channel status unavailable"));
    await pending;
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(false);
      expect(mounted.container.querySelector(".callout.danger")?.textContent).toBe(
        "Synthetic channel status unavailable",
      );
    });
    refresh().click();
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(true);
      expect(mounted.container.querySelector(".callout.danger")?.textContent).toBe(
        "Synthetic channel status unavailable",
      );
      expect(mounted.container.contains(row!)).toBe(true);
    });
    recovered.resolve({
      ...snapshot(),
      channelLabels: { discord: "Discord recovered" },
      channelAccounts: { discord: [{ accountId: "demo", connected: false, configured: true }] },
    });
    await pending;
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(false);
      expect(mounted.container.querySelector(".callout.danger")).toBeNull();
      expect(mounted.container.contains(row!)).toBe(true);
      expect(row?.querySelector(".settings-row__title")?.textContent).toBe("Discord recovered");
    });
    refresh().click();
    const invalidatedRead = channels.state.channelsRead!;
    fixture.publishEvent({ type: "event", event: "config.changed", payload: {} });
    invalidated.resolve(snapshot());
    await invalidatedRead.completion;
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(true);
      expect(refresh().textContent).toContain("Refreshing");
      expect(mounted.container.contains(row!)).toBe(true);
      expect(row?.querySelector(".settings-row__title")?.textContent).toBe("Discord");
    });
    followup.resolve({ ...snapshot(), channelLabels: { discord: "Configuration refreshed" } });
    await pending;
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(false);
      expect(row?.querySelector(".settings-row__title")?.textContent).toBe(
        "Configuration refreshed",
      );
    });
    refresh().click();
    const retiredRefresh = pending;
    await waitForSolid(() => expect(refresh().disabled).toBe(true));
    fixture.publish({
      ...fixture.gateway.snapshot,
      client: createTestGatewayClient(() => ({
        ...snapshot(),
        channelLabels: { discord: "Replacement connection" },
      })),
    });
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(false);
      expect(mounted.container.contains(row!)).toBe(false);
    });
    refresh().click();
    await pending;
    retired.reject(new Error("Retired channel failure"));
    await retiredRefresh;
    await waitForSolid(() => {
      expect(refresh().disabled).toBe(false);
      expect(mounted.container.querySelector(".callout.danger")).toBeNull();
      expect(mounted.container.textContent).toContain("Replacement connection");
    });
  } finally {
    failed.resolve(snapshot());
    recovered.resolve(snapshot());
    invalidated.resolve(snapshot());
    followup.resolve(snapshot());
    retired.resolve(snapshot());
    mounted.unmount();
    channels.dispose();
  }
});
