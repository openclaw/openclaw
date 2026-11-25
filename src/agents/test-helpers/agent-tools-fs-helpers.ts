/**
 * Filesystem tool assertion helpers for tests.
 *
 * Extracts text result blocks and asserts common read/write/edit tool bundles.
 */
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createSandboxedReadTool, wrapReadToolWithSkillContent } from "../agent-tools.read.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { ReadToolDetails } from "../sessions/tools/tool-contracts.js";
import type { createHostSandboxFsBridge } from "./host-sandbox-fs-bridge.js";

type TextResultBlock = { type: string; text?: string };

/** Extracts the first text block from a tool result. */
export function getTextContent(result?: { content?: TextResultBlock[] }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function expectTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`expected tool "${name}" in [${tools.map((entry) => entry.name).join(", ")}]`);
  }
  return tool;
}

/** Asserts read/write/edit tools are present and returns them by name. */
export function expectReadWriteEditTools<T extends { name: string }>(tools: T[]) {
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  expect(names).toContain("edit");
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
    editTool: expectTool(tools, "edit"),
  };
}

/** Asserts read/write tools are present and returns them by name. */
export function expectReadWriteTools<T extends { name: string }>(tools: T[]) {
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
  };
}

export function createSkillReadFixture() {
  const skillLocator = "/skills/pond/SKILL.md";
  const skillContent = "# Pond\ncomplete instructions";
  const fullSkillResult: AgentToolResult<ReadToolDetails> = {
    content: [{ type: "text", text: skillContent }],
    details: { kind: "text", content: skillContent },
  };

  function skillReadTool(execute: Parameters<typeof wrapReadToolWithSkillContent>[0]["execute"]) {
    return wrapReadToolWithSkillContent(
      {
        name: "read",
        label: "read",
        description: "read a file",
        parameters: Type.Object({ path: Type.String() }),
        execute,
      },
      [{ filePath: skillLocator }],
      { instructionDeliveryCache: new Map<string, Promise<boolean>>() },
    );
  }

  return { skillLocator, fullSkillResult, skillReadTool };
}

export function registerSkillReadDeduplicationTest(
  makeRead: (execute: () => Promise<AgentToolResult<ReadToolDetails>>) => {
    execute: (id: string, args: { path: string }) => Promise<AgentToolResult<ReadToolDetails>>;
  },
  locator: string,
  fullResult: AgentToolResult<ReadToolDetails>,
) {
  it("deduplicates sequential and concurrent successful skill reads within one attempt", async () => {
    let releaseRead = (): void => undefined;
    const pendingRead = new Promise<AgentToolResult<ReadToolDetails>>((resolve) => {
      releaseRead = () => resolve(fullResult);
    });
    const execute = vi.fn(() => pendingRead);
    const tool = makeRead(execute);
    const first = tool.execute("first-skill-read", { path: locator });
    const concurrent = tool.execute("concurrent-skill-read", { path: locator });
    expect(execute).toHaveBeenCalledTimes(1);
    releaseRead();
    expect(getTextContent(await first)).toBe("# Pond\ncomplete instructions");
    expect(getTextContent(await concurrent)).toContain("already served whole");
    expect(
      getTextContent(await tool.execute("sequential-skill-read", { path: locator })),
    ).toContain("already served whole");
    expect(execute).toHaveBeenCalledTimes(1);
  });
}

export function registerSandboxReadTests(
  fileFixture: (file: string, content: string | Uint8Array) => Promise<{ root: string }>,
  sandboxReadFixture: (
    file: string,
    content: string | Uint8Array,
  ) => Promise<{
    read: ReturnType<typeof createSandboxedReadTool>;
  }>,
  makeBridge: typeof createHostSandboxFsBridge,
) {
  const avifHeaderBuffer = Buffer.from("00000018667479706176696600000000617669666d696631", "hex");
  it("classifies sandbox AVIF reads from the already-read buffer", async () => {
    const { root: tmpDir } = await fileFixture("photo.bin", avifHeaderBuffer);
    const hostBridge = makeBridge(tmpDir);
    const readFile = vi.fn(hostBridge.readFile.bind(hostBridge));
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: { ...hostBridge, readFile },
    });

    const result = await readTool.execute("sandbox-avif", { path: "photo.bin" });

    expect(getTextContent(result)).toContain("Read image file [image/avif]");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("ignores a trailing newline when describing offsets beyond EOF", async () => {
    const { read } = await sandboxReadFixture("notes.txt", "one\ntwo\nthree\n");
    const result = await read.execute("read-offset-adaptive", {
      path: "notes.txt",
      offset: 99,
    });

    expect(getTextContent(result)).toBe(
      "Offset 99 is beyond end of file (3 lines total). Retry with offset <= 3.",
    );
  });
}
