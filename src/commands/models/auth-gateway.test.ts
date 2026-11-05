import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { readGatewayApiKeyParams } from "./auth-gateway.js";

async function withStdin<T>(stdin: Readable, run: () => Promise<T>): Promise<T> {
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  try {
    return await run();
  } finally {
    if (originalStdin) {
      Object.defineProperty(process, "stdin", originalStdin);
    } else {
      Reflect.deleteProperty(process, "stdin");
    }
    stdin.destroy();
  }
}

it.each([
  { name: "empty", input: "" },
  { name: "whitespace-only", input: " \n\t " },
])("explains how to retry $name API-key input", async ({ input }) => {
  await withStdin(Readable.from([input]), async () => {
    await expect(
      readGatewayApiKeyParams({ provider: "openai" }, new AbortController().signal),
    ).rejects.toThrow(
      "No API key was supplied. Rerun this command and paste a non-empty API key, or pipe one to stdin.",
    );
  });
});

it.each([Buffer.from([0xff]), Buffer.from([0xe2, 0x82])])(
  "rejects malformed UTF-8 before producing Gateway API-key parameters (%j)",
  async (bytes) => {
    await withStdin(Readable.from([Buffer.from("sk-synthetic-"), bytes]), async () => {
      await expect(
        readGatewayApiKeyParams({ provider: "openai" }, new AbortController().signal),
      ).rejects.toThrow("Piped auth input must be valid UTF-8.");
    });
  },
);

it("normalizes valid BOM/CRLF input with UTF-8 split across chunks", async () => {
  await withStdin(
    Readable.from([
      Buffer.from("\uFEFFsynthetic-"),
      Buffer.from([0xc3]),
      Buffer.from([0xa9]),
      Buffer.from("\r\n"),
    ]),
    async () => {
      await expect(
        readGatewayApiKeyParams(
          { provider: "sample", agent: "proof" },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ provider: "sample", apiKey: "synthetic-é", agentId: "proof" });
    },
  );
});

it("still aborts an unfinished piped credential read", async () => {
  const controller = new AbortController();
  await withStdin(new Readable({ read() {} }), async () => {
    const pending = readGatewayApiKeyParams({ provider: "openai" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
