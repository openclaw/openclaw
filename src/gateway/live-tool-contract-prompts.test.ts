import { describe, expect, it } from "vitest";
import {
  buildCanonicalTextReplyProbePrompt,
  buildCronToolCapabilityProbePrompt,
} from "../../test/helpers/live-tool-contract-prompts.js";

describe("live tool contract probe prompts", () => {
  it.each(["", "read", "group:fs", "r*", "bash"])(
    "keeps the requested capability challenge with cap=%j",
    (cap) => {
      const file = "/workspace/probe with spaces.txt";
      const prompt = buildCronToolCapabilityProbePrompt(file, cap);
      expect(prompt).toContain(
        cap === "bash"
          ? `Use the exec tool to run cat ${JSON.stringify(file)}.`
          : `Use the read tool to read ${JSON.stringify(file)}.`,
      );
      // Native code mode still has inert exec/wait wrappers with an empty nested
      // catalog. Their presence must not make the denial sentinel unreachable.
      expect(prompt).toContain("If the requested tool is unavailable");
      expect(prompt).toContain("reply exactly NO_TOOLS");
      expect(prompt).toContain("Do not substitute another tool");
      expect(prompt).not.toContain("If no tools are available");
    },
  );

  it.each(["SOURCE", "WARM", "COLD"])(
    "requests canonical %s evidence through final text, not outbound messaging",
    (phase) => {
      const marker = `CODEX-CANONICAL-${phase}`;
      const prompt = buildCanonicalTextReplyProbePrompt(marker);
      expect(prompt).toContain(`Reply exactly ${marker}`);
      expect(prompt).toContain("final assistant text");
      expect(prompt).toContain("Do not call tools or send a message");
    },
  );
});
