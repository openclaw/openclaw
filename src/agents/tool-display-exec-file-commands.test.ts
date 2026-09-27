import { describe, expect, it } from "vitest";
import { resolveExecDetail } from "./tool-display-exec.js";

describe("tool display details", () => {
  it.each([
    ["ls", "list files"],
    ["ls first second", "list files in first"],
    ["cat", "show output"],
    ["cat first second", "show first"],
    ["rm", "remove files"],
    ["rm -f first second", "remove first"],
    ["mkdir", "create folder"],
    ["mkdir -p folder", "create folder folder"],
    ["touch", "create file"],
    ["touch first second", "create file first"],
    ["cat ''", "show output"],
    ["cat 'two words'", "show two words"],
    ["cat two\\ words", "show two words"],
    ["ls -la", "list files"],
    ["ls -- -literal", "list files in -literal"],
    ["cat > output", "show output"],
    ["/usr/bin/LS folder", "list files in folder"],
    ["constructor target", "constructor target"],
    ["__proto__ target", "__proto__ target"],
    ["toString target", "toString target"],
    ["cat 'unterminated", "cat 'unterminated"],
  ])("preserves simple file-command display modes for %s", (command, expected) => {
    expect(resolveExecDetail({ command }, { detailMode: "explain" })).toBe(expected);
    expect(resolveExecDetail({ command, title: "Inspect files" })).toBe("Inspect files");
    const rawDetail = expected === command ? command : `${expected}, \`${command}\``;
    expect(resolveExecDetail({ command, title: "Inspect files" }, { detailMode: "raw" })).toBe(
      rawDetail,
    );
  });
});
