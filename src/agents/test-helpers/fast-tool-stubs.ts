import { vi } from "vitest";

type StubTool = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, never> };
  execute: (...args: unknown[]) => unknown;
};

export const stubTool = (name: string): StubTool => ({
  name,
  description: `${name} stub`,
  parameters: { type: "object", properties: {} as Record<string, never> },
  execute: vi.fn() as (...args: unknown[]) => unknown,
});

vi.mock("../tools/image-tool.js", () => ({
  createImageTool: () => stubTool("image"),
}));

vi.mock("../tools/web-tools.js", () => ({
  createWebSearchTool: () => null,
  createWebFetchTool: () => null,
}));

vi.mock("../../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  getPluginToolMeta: () => undefined,
}));
