import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { readGatewayApiKeyParams } from "./auth-gateway.js";

it.each([
  { name: "empty", input: "" },
  { name: "whitespace-only", input: " \n\t " },
])("explains how to retry $name API-key input", async ({ input }) => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdin = Readable.from([input]);
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  try {
    await expect(
      readGatewayApiKeyParams({ provider: "openai" }, new AbortController().signal),
    ).rejects.toThrow(
      "No API key was supplied. Rerun this command and paste a non-empty API key, or pipe one to stdin.",
    );
  } finally {
    if (originalStdin) {
      Object.defineProperty(process, "stdin", originalStdin);
    } else {
      Reflect.deleteProperty(process, "stdin");
    }
    stdin.destroy();
  }
});
