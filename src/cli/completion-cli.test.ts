import { describe, expect, it } from "vitest";
import { __testing } from "./completion-cli.js";

const { updateCompletionProfile } = __testing;

describe("updateCompletionProfile", () => {
  it("adds completion block to empty profile", () => {
    const result = updateCompletionProfile("", "openclaw", null, 'source "/tmp/openclaw.zsh"');
    expect(result.next).toBe('# OpenClaw Completion\nsource "/tmp/openclaw.zsh"\n');
    expect(result.changed).toBe(true);
    expect(result.hadExisting).toBe(false);
  });

  it("replaces existing completion block", () => {
    const content = 'export PATH="/usr/bin"\n# OpenClaw Completion\nsource "/old/path.zsh"\n';
    const result = updateCompletionProfile(
      content,
      "openclaw",
      "/old/path.zsh",
      'source "/new/path.zsh"',
    );
    expect(result.next).toContain('source "/new/path.zsh"');
    expect(result.next).not.toContain("/old/path.zsh");
    expect(result.hadExisting).toBe(true);
  });

  it("strips existing entries without adding header when sourceLine is empty", () => {
    const content = 'export FOO=1\n# OpenClaw Completion\nsource "/old/path.zsh"\nexport BAR=2\n';
    const result = updateCompletionProfile(content, "openclaw", "/old/path.zsh", "");
    expect(result.next).not.toContain("# OpenClaw Completion");
    expect(result.next).toContain("export FOO=1");
    expect(result.next).toContain("export BAR=2");
    expect(result.hadExisting).toBe(true);
  });

  it("returns unchanged when no existing entries and sourceLine is empty", () => {
    const content = "export FOO=1\n";
    const result = updateCompletionProfile(content, "openclaw", null, "");
    expect(result.changed).toBe(false);
  });
});
