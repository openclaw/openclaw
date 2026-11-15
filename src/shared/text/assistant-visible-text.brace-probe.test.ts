import { expect, it } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";
import { expectPrefixParity } from "./streaming.test-support.js";

it.each([
  ["tool header", '[tool:read] {"path":"notes.txt"}\nAfter', "After"],
  ["named header", "[read]\n{}\n[/read]\nAfter", "After"],
  ["CRLF", "Before\r\n[tool:read]\r\n{}\r\nAfter", "Before\r\nAfter"],
  ["CR", "Before\r[tool:read]\r{}\rAfter", "Before\rAfter"],
  ["tab-indented code", "\t[tool:read]\n{}\nAfter", "\t[tool:read]\n{}\nAfter"],
  ["name limit", `[tool:${"x".repeat(120)}] {}\nAfter`, "After"],
  ["overlong name", `[tool:${"x".repeat(121)}] {}\nAfter`, `[tool:${"x".repeat(121)}] {}\nAfter`],
  ["JSON prose", 'Set {"mode":"fast"} and continue.', 'Set {"mode":"fast"} and continue.'],
  ["fenced example", "```text\n[tool:read] {}\n```", "```text\n[tool:read] {}\n```"],
  ["inline example", "Use `[tool:read] {}` literally.", "Use `[tool:read] {}` literally."],
  ["named prose", "[read] {}\nAfter", "[read] {}\nAfter"],
  ["malformed then valid", "[invalid!]\n[tool:read] {}\nAfter", "[invalid!]\nAfter"],
])("preserves canonical brace-probe output at every split: %s", (_name, source, expected) => {
  expect(
    expectPrefixParity(
      source,
      () => createAssistantVisibleStreamText("final_answer"),
      (prefix) => sanitizeAssistantVisibleStreamText(prefix, "final_answer"),
    ),
  ).toBe(expected);
});
