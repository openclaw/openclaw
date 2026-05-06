import { describe, expect, it } from "vitest";
import { normalizeToolCallContent } from "./mcp-http.handlers.js";

describe("normalizeToolCallContent", () => {
  it("passes through text blocks unchanged", () => {
    const result = { content: [{ type: "text", text: "Hello world" }] };
    expect(normalizeToolCallContent(result)).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("passes through image blocks with data and mimeType", () => {
    const result = {
      content: [
        {
          type: "image",
          data: "base64encodeddata",
          mimeType: "image/png",
        },
      ],
    };
    expect(normalizeToolCallContent(result)).toEqual([
      {
        type: "image",
        data: "base64encodeddata",
        mimeType: "image/png",
      },
    ]);
  });

  it("passes through audio blocks with data and mimeType", () => {
    const result = {
      content: [
        {
          type: "audio",
          data: "base64encodedaudio",
          mimeType: "audio/mpeg",
        },
      ],
    };
    expect(normalizeToolCallContent(result)).toEqual([
      {
        type: "audio",
        data: "base64encodedaudio",
        mimeType: "audio/mpeg",
      },
    ]);
  });

  it("passes through resource blocks with resource field", () => {
    const result = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///path/to/file.txt",
            mimeType: "text/plain",
            text: "file contents",
          },
        },
      ],
    };
    expect(normalizeToolCallContent(result)).toEqual([
      {
        type: "resource",
        resource: {
          uri: "file:///path/to/file.txt",
          mimeType: "text/plain",
          text: "file contents",
        },
      },
    ]);
  });

  it("passes through resource_link blocks with uri", () => {
    const result = {
      content: [
        {
          type: "resource_link",
          uri: "https://example.com/file.pdf",
          name: "Document",
          mimeType: "application/pdf",
        },
      ],
    };
    expect(normalizeToolCallContent(result)).toEqual([
      {
        type: "resource_link",
        uri: "https://example.com/file.pdf",
        name: "Document",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("handles mixed content blocks", () => {
    const result = {
      content: [
        { type: "text", text: "Here is an image:" },
        { type: "image", data: "imagedata", mimeType: "image/jpeg" },
        { type: "text", text: "And a resource:" },
        {
          type: "resource",
          resource: { uri: "file:///doc.txt", text: "content" },
        },
      ],
    };
    expect(normalizeToolCallContent(result)).toEqual([
      { type: "text", text: "Here is an image:" },
      { type: "image", data: "imagedata", mimeType: "image/jpeg" },
      { type: "text", text: "And a resource:" },
      { type: "resource", resource: { uri: "file:///doc.txt", text: "content" } },
    ]);
  });

  it("falls back to text for string content", () => {
    const result = { content: ["just a string"] };
    expect(normalizeToolCallContent(result)).toEqual([{ type: "text", text: "just a string" }]);
  });

  it("falls back to text for non-array content", () => {
    const result = "plain string result";
    expect(normalizeToolCallContent(result)).toEqual([
      { type: "text", text: "plain string result" },
    ]);
  });

  it("falls back to JSON for malformed blocks", () => {
    const result = { content: [{ foo: "bar" }] };
    expect(normalizeToolCallContent(result)).toEqual([{ type: "text", text: '{"foo":"bar"}' }]);
  });
});
