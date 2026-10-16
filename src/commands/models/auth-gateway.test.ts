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

it.each([
  { name: "invalid byte", bytes: Buffer.from([0xff]) },
  { name: "incomplete sequence", bytes: Buffer.from([0xe2, 0x82]) },
])("rejects $name before producing Gateway API-key parameters", async ({ bytes }) => {
  const input = Buffer.concat([Buffer.from("sk-synthetic-before-"), bytes, Buffer.from("-after")]);
  await withStdin(Readable.from([input]), async () => {
    await expect(
      readGatewayApiKeyParams({ provider: "openai" }, new AbortController().signal),
    ).rejects.toThrow("Piped auth input must be valid UTF-8.");
  });
});

it("retains BOM/CRLF normalization and the requested provider and agent", async () => {
  await withStdin(
    Readable.from([Buffer.from("\uFEFFsk-synthetic-control-12345678\r\n")]),
    async () => {
      await expect(
        readGatewayApiKeyParams(
          { provider: "openai", agent: "proof" },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        provider: "openai",
        apiKey: "sk-synthetic-control-12345678",
        agentId: "proof",
      });
    },
  );
});

it("accepts a valid UTF-8 character split across stdin chunks", async () => {
  const chunks = [
    Buffer.from("synthetic-"),
    Buffer.from([0xc3]),
    Buffer.from([0xa9]),
    Buffer.from("-key"),
  ];
  await withStdin(Readable.from(chunks), async () => {
    await expect(
      readGatewayApiKeyParams({ provider: "synthetic" }, new AbortController().signal),
    ).resolves.toMatchObject({ apiKey: "synthetic-é-key" });
  });
});

it("still aborts an unfinished piped credential read", async () => {
  const controller = new AbortController();
  await withStdin(new Readable({ read() {} }), async () => {
    const pending = readGatewayApiKeyParams({ provider: "openai" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
