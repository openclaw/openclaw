import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  now,
  renderTemplate,
  type SessionEntry,
} from "../../../../test/helpers/export-html-template.js";
import {
  createEditTool,
  type EditToolOptions,
} from "../../../agents/sessions/tools/edit.js";
import type { EditToolDetails } from "../../../agents/sessions/tools/tool-contracts.js";

type EditOperations = NonNullable<EditToolOptions["operations"]>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function statFile(absolutePath: string) {
  const stat = await fs.stat(absolutePath);
  return {
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  } as const;
}

function messageEntry(id: string, parentId: string | null, message: unknown): SessionEntry {
  return { id, parentId, timestamp: now(), type: "message", message };
}

it("renders a recovered edit receipt as a diff", async () => {
  const workspace = tempDirs.make("openclaw-edit-export-");
  const filePath = path.join(workspace, "demo.ts");
  await fs.writeFile(filePath, 'const value = "foo";\r\n', "utf8");
  const operations: EditOperations = {
    access: fs.access,
    readFile: fs.readFile,
    statFile,
    writeFile: async (absolutePath, content) => {
      await fs.writeFile(absolutePath, content, "utf8");
      throw new Error("Simulated post-write failure");
    },
  };
  const result = await createEditTool(workspace, { operations }).execute(
    "edit-recovery",
    {
      path: "demo.ts",
      edits: [
        {
          oldText: 'const value = "foo";\n',
          newText: 'const value = "foobar";\n',
        },
      ],
    },
    undefined,
  );
  const details = result.details as EditToolDetails;

  const { document } = await renderTemplate({
    header: { id: "edit-recovery", timestamp: now() },
    entries: [
      messageEntry("call", null, {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-recovery",
            name: "edit",
            arguments: { path: "demo.ts", edits: [] },
          },
        ],
      }),
      messageEntry("result", "call", {
        role: "toolResult",
        toolCallId: "edit-recovery",
        content: result.content,
        details,
      }),
    ],
    leafId: "result",
    systemPrompt: "",
    tools: [],
  });

  expect(await fs.readFile(filePath, "utf8")).toBe('const value = "foobar";\r\n');
  expect(document.querySelector(".tool-diff .diff-added")?.textContent).toBe(
    '+1 const value = "foobar";',
  );
  expect(document.querySelector(".tool-output")).toBeNull();
});
