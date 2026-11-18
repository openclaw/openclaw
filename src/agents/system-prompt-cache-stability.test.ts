// Regression tests for system-prompt suffix stability across normal and
// announce/yield turns (issue #150081).
//
// Before the fix, five volatile fields in the system-prompt suffix changed
// between normal main turns and announce/yield turns, causing Ollama's
// prompt_eval_cached_count to drop from ~25k to ~14k tokens. The fix ensures
// the suffix digest stays constant regardless of turn type.

import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

describe("system-prompt suffix cache stability (#150081)", () => {
  it("SILENT_REPLY_TOKEN is a stable constant", () => {
    expect(SILENT_REPLY_TOKEN).toBeDefined();
    expect(typeof SILENT_REPLY_TOKEN).toBe("string");
    expect(SILENT_REPLY_TOKEN).toBe(SILENT_REPLY_TOKEN.trim());
  });

  it("Silent Replies section is not gated on silentReplyPromptMode", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./system-prompt.ts", import.meta.url), "utf-8"),
    );
    expect(source).not.toContain('silentReplyPromptMode !== "none" && [');
    expect(source).toContain("## Silent Replies");
  });

  it("completion-event guidance does not branch on suppressSilentTokenGuidance", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./system-prompt-messaging.ts", import.meta.url),
        "utf-8",
      ),
    );
    expect(source).not.toContain(
      'suppressSilentTokenGuidance\n    ? "- Completion event',
    );
    expect(source).toContain(
      `default to \${SILENT_REPLY_TOKEN}.\``,
    );
  });

  it("ownerList fallback uses resolveConfiguredCommandOwners when empty", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./../auto-reply/reply/get-reply-run-execute.ts", import.meta.url),
        "utf-8",
      ),
    );
    expect(source).toContain("resolveConfiguredCommandOwners");
    expect(source).toContain("command.ownerList?.length");
  });

  it("output directives are not gated on sourceMessageToolOnly", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./system-prompt.ts", import.meta.url), "utf-8"),
    );
    const directivesMatch = source.match(
      /buildAssistantOutputDirectivesSection\([\s\S]*?\}\)/,
    );
    expect(directivesMatch).toBeTruthy();
    const beforeDirectives = source.slice(0, directivesMatch!.index!);
    const lastGate = beforeDirectives.lastIndexOf("&&");
    const gateText = beforeDirectives.slice(lastGate - 50, lastGate + 2);
    expect(gateText).not.toContain("sourceMessageToolOnly");
  });
});
