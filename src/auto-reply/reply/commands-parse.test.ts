import { describe, expect, it } from "vitest";
import { parseConfigCommand } from "./config-commands.js";
import { parseDebugCommand } from "./debug-commands.js";
import { parseMessagingWindowCommand } from "./messaging-window-command.js";

describe("config/debug command parsing", () => {
  it("parses config/debug command actions and JSON payloads", () => {
    const cases: Array<{
      parse: (input: string) => unknown;
      input: string;
      expected: unknown;
    }> = [
      { parse: parseConfigCommand, input: "/config", expected: { action: "show" } },
      {
        parse: parseConfigCommand,
        input: "/config show",
        expected: { action: "show", path: undefined },
      },
      {
        parse: parseConfigCommand,
        input: "/config show foo.bar",
        expected: { action: "show", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: "/config get foo.bar",
        expected: { action: "show", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: "/config unset foo.bar",
        expected: { action: "unset", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: '/config set foo={"a":1}',
        expected: { action: "set", path: "foo", value: { a: 1 } },
      },
      { parse: parseDebugCommand, input: "/debug", expected: { action: "show" } },
      { parse: parseDebugCommand, input: "/debug show", expected: { action: "show" } },
      { parse: parseDebugCommand, input: "/debug reset", expected: { action: "reset" } },
      {
        parse: parseDebugCommand,
        input: "/debug unset foo.bar",
        expected: { action: "unset", path: "foo.bar" },
      },
      {
        parse: parseDebugCommand,
        input: '/debug set foo={"a":1}',
        expected: { action: "set", path: "foo", value: { a: 1 } },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window",
        expected: { action: "status" },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging-window global 3s",
        expected: { action: "set", scope: "global", debounceMs: 3000 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window 3s",
        expected: { action: "set", scope: "global", debounceMs: 3000 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window off",
        expected: { action: "set", scope: "global", debounceMs: 0 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window channel whatsapp 2500ms",
        expected: { action: "set", scope: "channel", channel: "whatsapp", debounceMs: 2500 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window whatsapp 2500ms",
        expected: { action: "set", scope: "channel", channel: "whatsapp", debounceMs: 2500 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window current 5s",
        expected: { action: "set", scope: "channel", channel: "current", debounceMs: 5000 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window current off",
        expected: { action: "set", scope: "channel", channel: "current", debounceMs: 0 },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window reset channel current",
        expected: { action: "reset", scope: "channel", channel: "current" },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window reset current",
        expected: { action: "reset", scope: "channel", channel: "current" },
      },
      {
        parse: parseMessagingWindowCommand,
        input: "/messaging_window off global",
        expected: { action: "set", scope: "global", debounceMs: 0 },
      },
    ];

    for (const testCase of cases) {
      expect(testCase.parse(testCase.input)).toEqual(testCase.expected);
    }
  });
});
