import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readAgentMessageFile } from "./agent-message-input.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent message stdin", () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  afterEach(() => {
    if (originalStdin) {
      Object.defineProperty(process, "stdin", originalStdin);
    }
  });

  function useStdin(chunks: Buffer[]) {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from(chunks),
    });
  }

  it("strips a BOM and preserves multiline Unicode across byte chunks", async () => {
    const bytes = Buffer.from("\uFEFF First line\n中文 😀\r\nLast line\n");
    useStdin([bytes.subarray(0, 17), bytes.subarray(17, 20), bytes.subarray(20)]);
    await expect(readAgentMessageFile("-")).resolves.toBe(" First line\n中文 😀\r\nLast line\n");
  });

  it.each([Buffer.from([0xff]), Buffer.from([0xe4, 0xb8])])(
    "rejects malformed or incomplete UTF-8 stdin",
    async (bytes) => {
      useStdin([bytes]);
      await expect(readAgentMessageFile("-")).rejects.toThrow("Message stdin must be valid UTF-8");
    },
  );

  it("uses the same 4 MiB byte budget for stdin as files", async () => {
    const atLimit = Buffer.alloc(4 * 1024 * 1024, "x");
    useStdin([atLimit]);
    await expect(readAgentMessageFile("-")).resolves.toHaveLength(atLimit.length);
    useStdin([atLimit, Buffer.from("x")]);
    await expect(readAgentMessageFile("-")).rejects.toThrow("Message stdin exceeds 4194304 bytes");
  });

  it("keeps explicitly addressed dash files separate from stdin", async () => {
    const root = tempDirs.make("agent-dash-file-");
    const file = path.join(root, "-");
    await fs.writeFile(file, "literal dash file");
    useStdin([Buffer.from("piped input")]);
    await expect(readAgentMessageFile(file)).resolves.toBe("literal dash file");
    await expect(readAgentMessageFile("-")).resolves.toBe("piped input");
  });
});
