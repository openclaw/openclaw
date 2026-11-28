import { expect, it } from "vitest";
import {
  formatAgentEnvelope,
  formatAgentEnvelopeTimestamp as stamp,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "./envelope.js";

const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5);
const optionsFor = (userTimezone: string) =>
  resolveEnvelopeFormatOptions({ agents: { defaults: { userTimezone } } });
type AgentOptions = Partial<Parameters<typeof formatAgentEnvelope>[0]>;
function agentEnvelope(options: AgentOptions = {}) {
  return formatAgentEnvelope({ channel: "WebChat", body: "hello", timestamp, ...options });
}
type InboundOptions = Partial<Parameters<typeof formatInboundEnvelope>[0]>;
function inboundEnvelope(options: InboundOptions = {}) {
  return formatInboundEnvelope({
    channel: "Telegram",
    from: "Alice",
    body: "hello",
    chatType: "direct",
    ...options,
  });
}

it.each<[AgentOptions, string | RegExp]>([
  [
    { from: "user1", host: "mac-mini", ip: "10.0.0.5", envelope: { timezone: "utc" } },
    "[WebChat user1 mac-mini 10.0.0.5 Thu 2025-01-02T03:04:05Z] hello",
  ],
  [{}, `[WebChat ${stamp(timestamp, { timezone: "local" })}] hello`],
  [
    { envelope: { timezone: "user", userTimezone: "Europe/Vienna" } },
    /\[WebChat Thu 2025-01-02 04:04:05 [^\]]+\] hello/,
  ],
  [
    { timestamp: new Date("2025-01-01T00:00:00Z"), envelope: { timezone: "gmt" } },
    "[WebChat Wed 2025-01-01T00:00:00Z] hello",
  ],
])("formats agent envelope %j", (options, expected) => {
  expect(agentEnvelope(options)).toEqual(
    typeof expected === "string" ? expected : expect.stringMatching(expected),
  );
});

it("falls back to the host timezone for an invalid configured user timezone", () => {
  const options = optionsFor("Not/A_Timezone");
  expect(options.timezone).toBe("local");
  expect(stamp(timestamp, options)).toBe(stamp(timestamp, { timezone: "local" }));
});

it("keeps the UTC fallback for an invalid explicit timezone option", () => {
  expect(stamp(timestamp, { timezone: "Not/A_Timezone" })).toBe(
    stamp(timestamp, { timezone: "utc" }),
  );
});
it.each<[InboundOptions, string]>([
  [
    { channel: "Signal", from: "Group", chatType: "group", sender: { name: "Bob", id: "42" } },
    "[Signal Group] Bob (42): hello",
  ],
  [{ from: "Alice id:123" }, "[Telegram Alice id:123] Alice: hello"],
  [
    { from: "Ops: Alice id:123", body: "/status" },
    "[Telegram Ops: Alice id:123] (sender): /status",
  ],
  [{ channel: "WhatsApp", from: "+1555", fromMe: true }, "[WhatsApp +1555] (self): hello"],
  [
    { from: "Room", chatType: "group", senderLabel: "Alice", fromMe: true },
    "[Telegram Room] Alice: hello",
  ],
])("labels the inbound sender: %j", (options, expected) => {
  expect(inboundEnvelope(options)).toBe(expected);
});

it.each([undefined, false])("formats elapsed time (enabled: %s)", (includeElapsed) => {
  const body = inboundEnvelope({
    timestamp,
    previousTimestamp: timestamp - 2 * 60 * 1000,
    envelope: { includeElapsed, includeTimestamp: false },
  });
  const elapsed = includeElapsed === false ? "" : " +2m";
  expect(body).toBe(`[Telegram Alice${elapsed}] Alice: hello`);
});

it("uses fixed envelope options while preserving the user timezone", () => {
  expect(optionsFor("Europe/Vienna")).toEqual({
    timezone: "Europe/Vienna",
    includeTimestamp: true,
    includeElapsed: true,
    userTimezone: "Europe/Vienna",
  });
});
