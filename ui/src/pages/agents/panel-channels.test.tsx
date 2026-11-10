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

function mountChannels(
  channels: ReturnType<typeof createChannelCapability>,
  onRefresh: () => void,
) {
  return mountSolid(() => {
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
        onRefresh={onRefresh}
        onSelectPanel={() => undefined}
      />
    );
  });
}

it("retains cached channels through retry and retires feedback with the connection", async () => {
  const failed = createDeferred<ChannelsStatusSnapshot>();
  const recovered = createDeferred<ChannelsStatusSnapshot>();
  const invalidated = createDeferred<ChannelsStatusSnapshot>();
  const followup = createDeferred<ChannelsStatusSnapshot>();
  const retired = createDeferred<ChannelsStatusSnapshot>();
  const reads = [failed, recovered, invalidated, followup, retired];
  const responses = [Promise.resolve(snapshot()), ...reads.map((read) => read.promise)];
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
  const mounted = mountChannels(channels, () => {
    pending = channels.refresh();
  });
  const refresh = () =>
    Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === "Refresh",
    )!;
  const row = Array.from(mounted.container.querySelectorAll(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent === "Discord",
  );
  const expectState = (busy: boolean, title: string | null, error: string | null = null) =>
    waitForSolid(() => {
      expect(refresh().disabled).toBe(busy);
      if (busy) {
        expect(refresh().getAttribute("aria-busy")).toBe("true");
      }
      expect(mounted.container.querySelector(".callout.danger")?.textContent ?? null).toBe(error);
      expect(mounted.container.contains(row!)).toBe(title !== null);
      if (title) {
        expect(row?.querySelector(".settings-row__title")?.textContent).toBe(title);
      }
    });
  try {
    expect(row).toBeDefined();
    await waitForSolid(() => expect(refresh().disabled).toBe(false));
    refresh().click();
    await expectState(true, "Discord");
    failed.reject(new Error("Synthetic channel status unavailable"));
    await pending;
    await expectState(false, "Discord", "Synthetic channel status unavailable");
    refresh().click();
    await expectState(true, "Discord", "Synthetic channel status unavailable");
    recovered.resolve({
      ...snapshot(),
      channelLabels: { discord: "Discord recovered" },
      channelAccounts: { discord: [{ accountId: "demo", connected: false, configured: true }] },
    });
    await pending;
    await expectState(false, "Discord recovered");
    refresh().click();
    const invalidatedRead = channels.state.channelsRead!;
    fixture.publishEvent({ type: "event", event: "config.changed", payload: {} });
    invalidated.resolve(snapshot());
    await invalidatedRead.completion;
    await expectState(true, "Discord");
    followup.resolve({ ...snapshot(), channelLabels: { discord: "Configuration refreshed" } });
    await pending;
    await expectState(false, "Configuration refreshed");
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
    await expectState(false, null);
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
    for (const read of reads) {
      read.resolve(snapshot());
    }
    mounted.unmount();
    channels.dispose();
  }
});

it("shows empty channels only after an accepted snapshot, not an unloaded or failed read", async () => {
  const reads = Array.from({ length: 4 }, () => createDeferred<ChannelsStatusSnapshot>());
  const responses = reads.map((read) => read.promise);
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    client: createTestGatewayClient(() => responses.shift()),
    phase: "connected",
    hello: gatewayHelloForMethods(["channels.status"], ["operator.read"]),
  });
  const channels = createChannelCapability(fixture.gateway);
  let pending: Promise<void> | undefined;
  const mounted = mountChannels(channels, () => {
    pending = channels.refresh();
  });
  const refresh = () => mounted.getByRole("button", { name: "Refresh" });
  const empty = {
    ...snapshot(),
    channelOrder: [],
    channelLabels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
  const expectPresentation = (hasEmpty: boolean, info: string | null) => {
    expect.soft(mounted.queryByText("No channels yet.") !== null).toBe(hasEmpty);
    expect.soft(mounted.container.querySelector(".callout.info")?.textContent ?? null).toBe(info);
    expect(mounted.getByRole("heading", { name: "Agent context" })).toBeDefined();
  };
  try {
    expectPresentation(false, "Load channels to see live status.");
    refresh().click();
    await waitForSolid(() => expect(refresh().getAttribute("aria-busy")).toBe("true"));
    expectPresentation(false, "Loading…");
    for (const [index, message] of [
      "Synthetic channel status unavailable",
      "Synthetic channel status denied",
    ].entries()) {
      reads[index]!.reject(new Error(message));
      await pending;
      await waitForSolid(() => expect(mounted.getByRole("alert").textContent).toBe(message));
      expectPresentation(false, null);
      refresh().click();
      await waitForSolid(() => expect(refresh().getAttribute("aria-busy")).toBe("true"));
      expectPresentation(false, null);
    }
    reads[2]!.resolve(empty);
    await pending;
    await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
    expectPresentation(true, null);
    const emptyNode = mounted.getByText("No channels yet.");
    refresh().click();
    await waitForSolid(() => expect(refresh().getAttribute("aria-busy")).toBe("true"));
    expectPresentation(true, null);
    reads[3]!.reject(new Error("Synthetic channel status unavailable"));
    await pending;
    await waitForSolid(() =>
      expect(mounted.getByRole("alert").textContent).toBe("Synthetic channel status unavailable"),
    );
    expectPresentation(true, null);
    expect(mounted.getByText("No channels yet.")).toBe(emptyNode);
  } finally {
    for (const read of reads) {
      read.resolve(empty);
    }
    mounted.unmount();
    channels.dispose();
  }
});
