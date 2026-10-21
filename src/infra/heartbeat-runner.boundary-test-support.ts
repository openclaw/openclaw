import { expect, onTestFinished, vi } from "vitest";
import * as currentTime from "../agents/current-time.js";
import * as replies from "../auto-reply/reply/get-reply-from-config.runtime.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resolveHeartbeatChannelPlugin } from "./heartbeat-runner-config.js";

export type HeartbeatReplyFn = typeof replies.getReplyFromConfig;

/** Bind once per fixture; retain the same callback through every pending wake. */
export function bindHeartbeatReply(reply: HeartbeatReplyFn): void {
  const spy = vi.spyOn(replies, "getReplyFromConfig").mockImplementation(reply);
  onTestFinished(() => spy.mockRestore());
}

/** Keep real durable delivery and the registered adapter's argument translation. */
export function bindHeartbeatSend(channel: "slack" | "telegram" | "whatsapp", send: unknown): void {
  const outbound = resolveHeartbeatChannelPlugin(channel)?.outbound;
  if (!outbound) {
    throw new Error(`Missing ${channel} fixture outbound adapter`);
  }
  if (outbound.sendText) {
    const sendText = outbound.sendText;
    const spy = vi
      .spyOn(outbound, "sendText")
      .mockImplementation((params) =>
        sendText({ ...params, deps: { ...params.deps, [channel]: send } }),
      );
    onTestFinished(() => spy.mockRestore());
  }
  if (outbound.sendMedia) {
    const sendMedia = outbound.sendMedia;
    const spy = vi
      .spyOn(outbound, "sendMedia")
      .mockImplementation((params) =>
        sendMedia({ ...params, deps: { ...params.deps, [channel]: send } }),
      );
    onTestFinished(() => spy.mockRestore());
  }
}

/** Observe the registered native transport where a case proves no dispatch occurred. */
export function observeHeartbeatSend(channel: "telegram") {
  const send = resolveHeartbeatChannelPlugin(channel)?.outbound;
  if (!send?.sendText) {
    throw new Error(`Missing ${channel} fixture text adapter`);
  }
  const spy = vi.spyOn(send, "sendText");
  onTestFinished(() => spy.mockRestore());
  return spy;
}

/** Readiness belongs to the registered adapter, not the heartbeat runner. */
export function bindHeartbeatReadiness(
  channel: "whatsapp",
  ready: NonNullable<NonNullable<ChannelPlugin["heartbeat"]>["checkReady"]>,
) {
  const heartbeat = resolveHeartbeatChannelPlugin(channel)?.heartbeat;
  if (!heartbeat?.checkReady) {
    throw new Error(`Missing ${channel} fixture readiness adapter`);
  }
  const spy = vi.spyOn(heartbeat, "checkReady").mockImplementation(ready);
  onTestFinished(() => spy.mockRestore());
}

/** Observe the real captured execution time; never replace the process clock. */
export function observeHeartbeatClock() {
  const clock = vi.spyOn(currentTime, "appendCronStyleCurrentTimeLine");
  const observedBefore = Date.now();
  onTestFinished(() => clock.mockRestore());
  function current() {
    const startedAt = clock.mock.calls.at(-1)?.[2];
    if (typeof startedAt !== "number") {
      throw new Error("Expected the heartbeat's real prompt timestamp");
    }
    expect(startedAt).toBeGreaterThanOrEqual(observedBefore);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    return startedAt;
  }
  const run = async <T>(execute: () => Promise<T>) => {
    const before = Date.now();
    const index = clock.mock.calls.length;
    const result = await execute();
    const after = Date.now();
    const call = clock.mock.calls[index];
    if (typeof call?.[2] !== "number") {
      throw new Error("Expected the heartbeat's real prompt timestamp");
    }
    const startedAt = call[2];
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(after);
    return { result, startedAt };
  };
  return { current, run };
}

/** A nonempty UTC window separated from the current hour by at least eleven hours. */
export function inactiveHeartbeatHours() {
  const hour = new Date().getUTCHours();
  const format = (value: number) => `${String(value % 24).padStart(2, "0")}:00`;
  return { start: format(hour + 12), end: format(hour + 13), timezone: "UTC" };
}
