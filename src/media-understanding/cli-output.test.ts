import { describe, expect, it } from "vitest";
import { resolveCliOutput } from "./cli-output.js";

describe("Gemini CLI media output", () => {
  it.each<[string, string | null]>([
    [
      'debug: invoking gemini\n{"response":"a useful description","usage":{"inputTokens":12,"outputTokens":4}}',
      "a useful description",
    ],
    ['debug: "hello { world" {"response":"ok"}', "ok"],
    ['debug: it\'s done {"response":"ok"}', "ok"],
    [JSON.stringify({ response: "{".repeat(33) }), "{".repeat(33)],
    [
      JSON.stringify({ response: "array response", items: [{ id: 1 }, { id: 2 }] }, null, 2),
      "array response",
    ],
    ['{"response":"good"} {"meta":{"response":"bad"} broken}', "good"],
    ['{"response":"good"} {"meta":{"response":"bad"}', "good"],
    ['{"response":"good"} {"meta" {"response":"bad"}}', "good"],
    ['noise {broken {"response":"bad"}}', null],
    ['{"response":"good"}\nnoise {broken\n{"response":"bad"}}', "good"],
  ])("extracts the last complete response from %s", async (stdout, response) => {
    await expect(
      resolveCliOutput({ command: "gemini", args: [], stdout, mediaPath: "unused" }),
    ).resolves.toBe(response ?? stdout.trim());
  });
});
