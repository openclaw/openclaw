import { describe, expect, it } from "vitest";
import { resolveExecDetail } from "./tool-display-exec.js";

describe("tool display details", () => {
  it.each([
    ["rm -f first second", "remove first"],
    ["mkdir -p folder", "create folder folder"],
    ["touch first second", "create file first"],
    ["cat ''", "show output"],
    ["cat 'two words'", "show two words"],
    ["cat two\\ words", "show two words"],
    ["ls -la", "list files"],
    ["ls -- -literal", "list files in -literal"],
    ["cat > output", "show output"],
    ["/usr/bin/LS folder", "list files in folder"],
    ["__proto__ target", "__proto__ target"],
    ["cat 'unterminated", "cat 'unterminated"],
  ])("preserves simple file-command display modes for %s", (command, expected) => {
    expect(resolveExecDetail({ command }, { detailMode: "explain" })).toBe(expected);
  });
});
