import { expect } from "vitest";

type TextResultBlock = { type: string; text?: string };

export function getTextContent(result?: { content?: TextResultBlock[] }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

export function expectReadWriteEditTools<T extends { name: string }>(tools: T[]) {
  const readTool = tools.find((tool) => tool.name === "read");
  const writeTool = tools.find((tool) => tool.name === "write");
  const editTool = tools.find((tool) => tool.name === "edit");
  expect(readTool).toBeDefined();
  expect(writeTool).toBeDefined();
  expect(editTool).toBeDefined();
  return {
    readTool: readTool as T,
    writeTool: writeTool as T,
    editTool: editTool as T,
  };
}

export function expectReadWriteTools<T extends { name: string }>(tools: T[]) {
  const readTool = tools.find((tool) => tool.name === "read");
  const writeTool = tools.find((tool) => tool.name === "write");
  expect(readTool).toBeDefined();
  expect(writeTool).toBeDefined();
  return {
    readTool: readTool as T,
    writeTool: writeTool as T,
  };
}
