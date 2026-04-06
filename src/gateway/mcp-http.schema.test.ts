import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: mocks.logWarn,
}));

let buildMcpToolSchema: typeof import("./mcp-http.schema.js").buildMcpToolSchema;
let logWarn: typeof import("../logger.js").logWarn;

beforeAll(async () => {
  ({ buildMcpToolSchema } = await import("./mcp-http.schema.js"));
  ({ logWarn } = await import("../logger.js"));
});

beforeEach(() => {
  vi.mocked(logWarn).mockReset();
});

describe("buildMcpToolSchema", () => {
  it("flattens enum-like nested unions without conflict warnings", () => {
    const toolSchema = buildMcpToolSchema([
      {
        name: "feishu_drive",
        description: "Drive operations",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: {
                action: { const: "info" },
                file_token: { type: "string" },
                type: {
                  anyOf: [
                    { const: "doc" },
                    { const: "docx" },
                    { const: "sheet" },
                    { const: "bitable" },
                    { const: "folder" },
                    { const: "file" },
                    { const: "mindnote" },
                    { const: "shortcut" },
                  ],
                },
              },
              required: ["action", "file_token", "type"],
            },
            {
              type: "object",
              properties: {
                action: { const: "delete" },
                file_token: { type: "string" },
                type: {
                  anyOf: [
                    { const: "doc" },
                    { const: "docx" },
                    { const: "sheet" },
                    { const: "bitable" },
                    { const: "folder" },
                    { const: "file" },
                    { const: "mindnote" },
                    { const: "shortcut" },
                  ],
                },
              },
              required: ["action", "file_token", "type"],
            },
            {
              type: "object",
              properties: {
                action: { const: "add_comment" },
                file_token: { type: "string" },
                file_type: {
                  anyOf: [{ const: "doc" }, { const: "docx" }],
                  description: "Document type. Defaults to docx when omitted.",
                },
                content: { type: "string" },
              },
              required: ["action", "file_token", "content"],
            },
            {
              type: "object",
              properties: {
                action: { const: "list_comment_replies" },
                file_token: { type: "string" },
                file_type: {
                  anyOf: [
                    { const: "doc" },
                    { const: "docx" },
                    { const: "sheet" },
                    { const: "file" },
                    { const: "slides" },
                  ],
                },
                comment_id: { type: "string" },
              },
              required: ["action", "file_token", "comment_id"],
            },
          ],
        },
      },
    ] as Parameters<typeof buildMcpToolSchema>[0]);

    expect(logWarn).not.toHaveBeenCalled();
    expect(toolSchema).toEqual([
      {
        name: "feishu_drive",
        description: "Drive operations",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["info", "delete", "add_comment", "list_comment_replies"],
            },
            file_token: { type: "string" },
            type: {
              type: "string",
              enum: ["doc", "docx", "sheet", "bitable", "folder", "file", "mindnote", "shortcut"],
            },
            file_type: {
              description: "Document type. Defaults to docx when omitted.",
              type: "string",
              enum: ["doc", "docx", "sheet", "file", "slides"],
            },
            content: { type: "string" },
            comment_id: { type: "string" },
          },
          required: ["action", "file_token"],
        },
      },
    ]);
  });
});
