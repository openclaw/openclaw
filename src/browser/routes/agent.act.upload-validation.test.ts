import { describe, expect, it } from "vitest";
import { validateUploadPaths, validateUploadPathsWithRoot } from "./agent.act.js";

describe("validateUploadPaths", () => {
  it("allows simple relative paths", () => {
    expect(() => validateUploadPaths(["photo.jpg"])).not.toThrow();
    expect(() => validateUploadPaths(["uploads/file.txt"])).not.toThrow();
    expect(() => validateUploadPaths(["a/b/c.png"])).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => validateUploadPaths(["/etc/passwd"])).toThrow(
      "Absolute upload paths are not allowed",
    );
    expect(() => validateUploadPaths(["/root/.ssh/id_rsa"])).toThrow(
      "Absolute upload paths are not allowed",
    );
  });

  it("rejects traversal sequences", () => {
    expect(() => validateUploadPaths(["../../etc/passwd"])).toThrow(
      "Upload path contains directory traversal",
    );
    expect(() => validateUploadPaths(["../secret"])).toThrow(
      "Upload path contains directory traversal",
    );
  });

  it("rejects traversal disguised with intermediate dirs", () => {
    expect(() => validateUploadPaths(["uploads/../../etc/passwd"])).toThrow(
      "Upload path contains directory traversal",
    );
  });

  it("validates all paths in the array", () => {
    expect(() => validateUploadPaths(["ok.txt", "/etc/shadow"])).toThrow(
      "Absolute upload paths are not allowed",
    );
  });
});

describe("validateUploadPathsWithRoot", () => {
  const sandboxRoot = "/home/user/sandbox";

  it("allows relative paths within sandbox", () => {
    expect(() => validateUploadPathsWithRoot(["uploads/photo.jpg"], sandboxRoot)).not.toThrow();
    expect(() => validateUploadPathsWithRoot(["file.txt"], sandboxRoot)).not.toThrow();
  });

  it("allows absolute paths inside sandbox", () => {
    expect(() =>
      validateUploadPathsWithRoot(["/home/user/sandbox/uploads/photo.jpg"], sandboxRoot),
    ).not.toThrow();
  });

  it("rejects traversal escaping sandbox", () => {
    expect(() => validateUploadPathsWithRoot(["../../etc/passwd"], sandboxRoot)).toThrow(
      "Upload path escapes sandbox",
    );
    expect(() => validateUploadPathsWithRoot(["../secret.key"], sandboxRoot)).toThrow(
      "Upload path escapes sandbox",
    );
  });

  it("rejects absolute paths outside sandbox", () => {
    expect(() => validateUploadPathsWithRoot(["/etc/passwd"], sandboxRoot)).toThrow(
      "Upload path escapes sandbox",
    );
  });

  it("rejects traversal disguised with intermediate dirs", () => {
    expect(() => validateUploadPathsWithRoot(["uploads/../../etc/passwd"], sandboxRoot)).toThrow(
      "Upload path escapes sandbox",
    );
  });
});
