import { describe, expect, it } from "vitest";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";

describe("matchesExecAllowlistPattern", () => {
  it("matches case-insensitively by default", () => {
    expect(matchesExecAllowlistPattern("/workspace/notes/**", "/workspace/Notes/todo.txt")).toBe(
      true,
    );
  });

  it("supports case-sensitive matching when requested", () => {
    expect(
      matchesExecAllowlistPattern("/workspace/notes/**", "/workspace/notes/todo.txt", {
        caseSensitive: true,
      }),
    ).toBe(true);
    expect(
      matchesExecAllowlistPattern("/workspace/notes/**", "/workspace/Notes/todo.txt", {
        caseSensitive: true,
      }),
    ).toBe(false);
  });
});
