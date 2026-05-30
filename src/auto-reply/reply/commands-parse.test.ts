import { describe, expect, it } from "vitest";
import { parseConfigCommand } from "./config-commands.js";
import { parseDebugCommand } from "./debug-commands.js";

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
      {
        parse: parseConfigCommand,
        input: '/config set messages.responsePrefix="cu-quoted"',
        expected: { action: "set", path: "messages.responsePrefix", value: "cu-quoted" },
      },
      {
        parse: parseConfigCommand,
        input: '/config set messages.responsePrefix="[cu-bracket]"',
        expected: { action: "set", path: "messages.responsePrefix", value: "[cu-bracket]" },
      },
      {
        parse: parseConfigCommand,
        input: "/config set messages.responsePrefix=[cu-unquoted]",
        expected: { action: "set", path: "messages.responsePrefix", value: "[cu-unquoted]" },
      },
      {
        parse: parseConfigCommand,
        input: "/config set messages.responsePrefix={cu-objectish}",
        expected: { action: "set", path: "messages.responsePrefix", value: "{cu-objectish}" },
      },
      {
        parse: parseConfigCommand,
        input: '/config set messages.responsePrefix="pre[cu]post"',
        expected: { action: "set", path: "messages.responsePrefix", value: "pre[cu]post" },
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
    ];

    for (const testCase of cases) {
      expect(testCase.parse(testCase.input)).toEqual(testCase.expected);
    }
  });
});
