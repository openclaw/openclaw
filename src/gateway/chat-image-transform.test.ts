import { describe, expect, it } from "vitest";
import { transformMarkdownImagePaths } from "./chat-image-transform.js";

describe("transformMarkdownImagePaths", () => {
  const workspaceDir = "/home/user/project";

  it("transforms relative image paths", () => {
    const input = "Here is an image: ![screenshot](./images/test.png)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    const expectedPath = Buffer.from("/home/user/project/images/test.png").toString("base64url");
    expect(result).toBe(`Here is an image: ![screenshot](/__file__/${expectedPath})`);
  });

  it("transforms absolute image paths", () => {
    const input = "![img](/tmp/screenshot.png)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    const expectedPath = Buffer.from("/tmp/screenshot.png").toString("base64url");
    expect(result).toBe(`![img](/__file__/${expectedPath})`);
  });

  it("leaves https URLs untouched", () => {
    const input = "![photo](https://example.com/photo.jpg)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    expect(result).toBe(input);
  });

  it("leaves http URLs untouched", () => {
    const input = "![photo](http://example.com/photo.jpg)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    expect(result).toBe(input);
  });

  it("leaves data URIs untouched", () => {
    const input = "![img](data:image/png;base64,abc123)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    expect(result).toBe(input);
  });

  it("leaves already transformed paths untouched", () => {
    const encoded = Buffer.from("/tmp/test.png").toString("base64url");
    const input = `![img](/__file__/${encoded})`;
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    expect(result).toBe(input);
  });

  it("handles basePath prefix", () => {
    const input = "![img](test.png)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "/ui");
    const expectedPath = Buffer.from("/home/user/project/test.png").toString("base64url");
    expect(result).toBe(`![img](/ui/__file__/${expectedPath})`);
  });

  it("handles text without markdown images", () => {
    const input = "Hello, this is plain text without images.";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    expect(result).toBe(input);
  });

  it("transforms multiple images in one text block", () => {
    const input = "![a](./a.png) and ![b](./b.png)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    const encodedA = Buffer.from("/home/user/project/a.png").toString("base64url");
    const encodedB = Buffer.from("/home/user/project/b.png").toString("base64url");
    expect(result).toBe(`![a](/__file__/${encodedA}) and ![b](/__file__/${encodedB})`);
  });

  it("handles bare filename without ./ prefix", () => {
    const input = "![img](screenshot.png)";
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    const expectedPath = Buffer.from("/home/user/project/screenshot.png").toString("base64url");
    expect(result).toBe(`![img](/__file__/${expectedPath})`);
  });

  it("handles image with title attribute", () => {
    const input = '![alt](./img.png "A title")';
    const result = transformMarkdownImagePaths(input, workspaceDir, "");
    const expectedPath = Buffer.from("/home/user/project/img.png").toString("base64url");
    expect(result).toBe(`![alt](/__file__/${expectedPath})`);
  });

  it("transforms absolute paths without workspace dir", () => {
    const input = "![img](/tmp/screenshot.png)";
    const result = transformMarkdownImagePaths(input, undefined, "");
    const expectedPath = Buffer.from("/tmp/screenshot.png").toString("base64url");
    expect(result).toBe(`![img](/__file__/${expectedPath})`);
  });

  it("leaves relative paths untouched without workspace dir", () => {
    const input = "![img](./images/test.png)";
    const result = transformMarkdownImagePaths(input, undefined, "");
    expect(result).toBe(input);
  });
});
