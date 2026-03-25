// Contract suite installers for channel plugin tests.
import { expect } from "vitest";
import type { MsgContext } from "../../../auto-reply/templating.js";
import type { ChannelPlugin } from "../types.js";

/** Assert that an inbound MsgContext satisfies the channel inbound context contract. */
export function expectChannelInboundContextContract(ctx: MsgContext | undefined): void {
  expect(ctx).toBeTruthy();
  if (!ctx) return;
  expect(typeof ctx.SessionKey).toBe("string");
  expect(ctx.SessionKey).not.toBe("");
  expect(typeof ctx.Surface).toBe("string");
  expect(ctx.Surface).not.toBe("");
}

/** Install the channel plugin contract suite for a given plugin. */
export function installChannelPluginContractSuite(_params: {
  plugin: ChannelPlugin;
}): void {
  // Placeholder: add shared plugin contract assertions here.
}

/** Install the channel setup contract suite for a given plugin and cases. */
export function installChannelSetupContractSuite(_params: {
  plugin: ChannelPlugin;
  cases: unknown[];
}): void {
  // Placeholder: add shared setup contract assertions here.
}

/** Install the channel status contract suite for a given plugin and cases. */
export function installChannelStatusContractSuite(_params: {
  plugin: ChannelPlugin;
  cases: unknown[];
}): void {
  // Placeholder: add shared status contract assertions here.
}

/** Install the channel actions contract suite for a given plugin and cases. */
export function installChannelActionsContractSuite(_params: {
  plugin: ChannelPlugin;
  cases: unknown[];
  unsupportedAction?: unknown;
}): void {
  // Placeholder: add shared actions contract assertions here.
}
