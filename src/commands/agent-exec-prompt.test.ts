import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentExecPrompt } from "./agent-exec.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("agent exec prompt sources", () => {
  it("accepts a positional prompt", async () => {
    await expect(resolveAgentExecPrompt("fix it", undefined)).resolves.toBe("fix it");
  });

  it("reads a UTF-8 prompt file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-exec-prompt-"));
    tempRoots.push(root);
    const promptPath = path.join(root, "prompt.md");
    await fs.writeFile(promptPath, "\uFEFFline one\nline two", "utf8");

    await expect(resolveAgentExecPrompt(undefined, promptPath)).resolves.toBe("line one\nline two");
  });

  it("reads --message-file - from stdin", async () => {
    const stdin = Readable.from([Buffer.from("from stdin", "utf8")]);
    await expect(resolveAgentExecPrompt(undefined, "-", stdin)).resolves.toBe("from stdin");
  });
});
