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

// Regression tests for prompt-cache fingerprint stability across transcript reloads.
//
// When messages are reloaded from the transcript database, fresh message objects
// are created with different references and potentially different timestamps
// (persistence time vs original). The reference-based divergence check caused
// false-positive history rewrite detections that dropped the prompt cache from
// ~90k tokens to ~3k, forcing full recomputation. The fix compares fingerprint
// identity (content + non-omitted envelope fields) instead of object references,
// and omits timestamp from the envelope fingerprint since it is persistence
// metadata that does not appear in the prompt sent to the LLM.

describe("prompt-cache fingerprint stability across reloads", () => {
  it("omits timestamp from the envelope fingerprint", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./embedded-agent-runner/prompt-cache-history.ts", import.meta.url),
        "utf-8",
      ),
    );
    expect(source).toContain('"timestamp"');
    expect(source).toContain("MESSAGE_ENVELOPE_OMITTED_FIELDS");
    // Verify timestamp is in the omit set
    const omitSetMatch = source.match(/MESSAGE_ENVELOPE_OMITTED_FIELDS = new Set\(\[([^\]]+)\]\)/);
    expect(omitSetMatch).toBeTruthy();
    expect(omitSetMatch![1]).toContain('"timestamp"');
  });

  it("uses fingerprint identity comparison instead of reference comparison", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./embedded-agent-runner/prompt-cache-observability.ts", import.meta.url),
        "utf-8",
      ),
    );
    // The old code used: message !== history[index]
    // The new code uses: message !== history[index] && message.packed.slice(...) !== ...
    expect(source).not.toContain(
      "previous.history.findIndex((message, index) => message !== history[index])",
    );
    expect(source).toContain("identityLength");
    expect(source).toContain("packed.slice");
  });
});
