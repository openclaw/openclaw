import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import {
  createSecretEgressBodyTransform,
  SecretEgressSubstitutionError,
  substituteSecretEgressBody,
} from "./stream-substitution.js";

describe("secret egress binary scanner", () => {
  it("rewrites shrinking UTF-8 sentinels in the original backing store without recursion", () => {
    const nested = sealSecretSentinel("synthetic-inner", { label: "inner" });
    const value = "synthetic-🦞-" + nested;
    const sentinel = sealSecretSentinel(value, { label: "outer" });
    const binary = Buffer.from([0, 255, 128, 1]);
    const input = Buffer.concat([
      binary,
      Buffer.from(sentinel),
      binary,
      Buffer.from(sentinel),
      binary,
    ]);
    const expected = Buffer.concat([
      binary,
      Buffer.from(value),
      binary,
      Buffer.from(value),
      binary,
    ]);
    let substitutions = 0;
    const output = substituteSecretEgressBody(input, {
      resolveSentinel: resolveSecretSentinel,
      onSubstitution: () => substitutions++,
    });
    expect(output).toEqual(expected);
    // The media memory contract forbids a second payload-sized allocation.
    expect(output.buffer).toBe(input.buffer);
    expect(substitutions).toBe(2);
  });

  it("streams one-byte chunks across every sentinel boundary without changing binary bytes", async () => {
    const value = "synthetic-🦞";
    const sentinel = sealSecretSentinel(value, { label: "one-byte" });
    const binary = Buffer.from([0, 255, 128, 1]);
    const input = Buffer.concat([binary, Buffer.from(sentinel), binary]);
    const chunks: Buffer[] = [];
    const stream = createSecretEgressBodyTransform({
      resolveSentinel: resolveSecretSentinel,
      onSubstitution: () => {},
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(stream, "end");
    for (const byte of input) {
      stream.write(Buffer.from([byte]));
    }
    stream.end();
    await ended;
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([binary, Buffer.from(value), binary]));
  });

  it.each(["buffered", "streaming"] as const)(
    "fails closed for an expanding %s resolver",
    async (mode) => {
      const sentinel = sealSecretSentinel("synthetic", { label: "expansion" });
      const params = {
        resolveSentinel: () => "x".repeat(sentinel.length + 1),
        onSubstitution: () => {},
      };
      if (mode === "buffered") {
        const input = Buffer.from(sentinel);
        expect(() => substituteSecretEgressBody(input, params)).toThrow(
          SecretEgressSubstitutionError,
        );
        expect(input.toString()).toBe(sentinel);
        return;
      }
      const stream = createSecretEgressBodyTransform(params);
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      const error = once(stream, "error");
      stream.end(sentinel);
      expect((await error)[0]).toBeInstanceOf(SecretEgressSubstitutionError);
      expect(chunks).toEqual([]);
    },
  );
});
