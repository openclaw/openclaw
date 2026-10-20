// @vitest-environment jsdom
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createTeamScaleSidebarListOwner } from "../../test-helpers/control-ui-sidebar-list-fixture.ts";
import { createControlUiTeamScaleFixture } from "../../test-helpers/control-ui-team-scale-fixture.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

it("reproduces paired sidebar refreshes for Team membership churn while applying authoritative membership", async () => {
  vi.useFakeTimers();
  const now = 1_800_000_000_000;
  vi.setSystemTime(now);
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const fixture = createControlUiTeamScaleFixture({ now, sidebarListChurn: true });
  const inventory = fixture.sidebarListInput;
  const owner = createTeamScaleSidebarListOwner(inventory);
  const reads: Array<{ atMs: number; personal: boolean; ownerFirst: boolean }> = [];
  const client = createTestGatewayClient(async (method, params) => {
    expect(method).toBe("sessions.list");
    if (!Value.Check(SessionsListParamsSchema, params)) {
      throw new Error("Invalid sessions.list request");
    }
    reads.push({
      atMs: Date.now() - now,
      personal: params.involvingMe === true,
      ownerFirst: params.ownerFirst === true,
    });
    return owner.list(params).result;
  });
  const harness = createGatewayHarness(client, undefined, {
    selfUser: { id: inventory.viewerProfileId },
  });
  const sessions = createTestSessionCapability(harness.gateway);
  const primary = { agentId: "main", limit: 200 };
  const personal = { ...primary, involvingMe: true };
  const unsubscribe = sessions.subscribeList(personal, () => {});
  try {
    await sessions.refresh({ ...primary, force: true });
    await sessions.refreshList(personal);
    const bootReads = reads.length;
    expect(sessions.state.result?.sessions.length).toBeGreaterThanOrEqual(200);
    expect(sessions.listSnapshot(personal).result?.sessions).toHaveLength(200);
    for (const event of fixture.liveEvents) {
      await vi.advanceTimersByTimeAsync(event.atMs - (Date.now() - now));
      owner.apply(event.sessionMutation);
      harness.emitEvent({ type: "event", event: event.event, payload: event.payload });
    }
    await vi.advanceTimersByTimeAsync(16_000);

    const sustained = reads.slice(bootReads).filter((read) => read.atMs >= 6_000);
    const sharedReads = sustained.filter((read) => !read.personal);
    const personalReads = sustained.filter((read) => read.personal);
    expect(sharedReads.length).toBeGreaterThanOrEqual(3);
    expect(personalReads.length).toBeGreaterThanOrEqual(3);
    expect(sharedReads.every((read) => read.ownerFirst)).toBe(true);
    for (const shared of sharedReads) {
      expect(personalReads.some((read) => Math.abs(read.atMs - shared.atMs) <= 500)).toBe(true);
    }
    for (const windowReads of [sharedReads, personalReads]) {
      for (let index = 1; index < windowReads.length; index++) {
        const interval = windowReads[index]!.atMs - windowReads[index - 1]!.atMs;
        expect(interval).toBeGreaterThanOrEqual(5_000);
        expect(interval).toBeLessThanOrEqual(6_000);
      }
    }
    const refreshes = owner.stats().slice(bootReads);
    expect(refreshes.every((read) => read.rowsSent >= 200)).toBe(true);
    expect(refreshes.filter((read) => read.changedRows < 10).length).toBeGreaterThan(
      refreshes.length / 2,
    );

    const sharedKeys = sessions.state.result!.sessions.map((row) => row.key);
    const personalKeys = sessions.listSnapshot(personal).result!.sessions.map((row) => row.key);
    for (const keys of [sharedKeys, personalKeys]) {
      expect(keys).not.toContain(inventory.rows[15]!.key);
      expect(keys).toContain(inventory.rows[12]!.key);
      expect(keys.some((key) => key.includes("team-scale-created-"))).toBe(false);
    }
    for (const index of [241, 242, 243]) {
      expect(sharedKeys).toContain(inventory.rows[index]!.key);
      expect(personalKeys).not.toContain(inventory.rows[index]!.key);
    }
    expect(sessions.listSnapshot(personal).result?.sessions).toHaveLength(200);
  } finally {
    unsubscribe();
    sessions.dispose();
    random.mockRestore();
    vi.useRealTimers();
  }
});
