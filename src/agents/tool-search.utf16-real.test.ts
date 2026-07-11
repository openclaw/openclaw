// Real child-process proof that tool_search_code stderr tails stay UTF-16 safe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let toolSearch: typeof import("./tool-search.js");

describe("tool_search_code real child-exit UTF-16 safety", () => {
  beforeAll(async () => {
    toolSearch = await import("./tool-search.js");
  });

  it("keeps the stderr tail valid when a real child exits on a surrogate boundary", async () => {
    toolSearch.testing.setToolSearchCodeModeSupportedForTest(true);
    toolSearch.testing.setToolSearchMinCodeTimeoutMsForTest(60_000);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-search-utf16-real-"));
    const payloadPath = path.join(tempDir, "payload.mjs");
    const fakeNodePath = path.join(tempDir, "fake-node");

    // Construct stderr whose raw 500-code-unit tail boundary bisects the emoji surrogate pair.
    const stderrPayload = `${"a".repeat(500)}😀${"a".repeat(499)}`;
    await fs.writeFile(
      payloadPath,
      `process.stderr.write(${JSON.stringify(stderrPayload)}); process.exit(1);`,
      "utf8",
    );

    // Point process.execPath at a tiny wrapper so spawn() still invokes Node,
    // but the child writes the controlled stderr payload and exits nonzero.
    const originalExecPath = process.execPath;
    await fs.writeFile(
      fakeNodePath,
      `#!/bin/sh\nexec '${originalExecPath}' '${payloadPath}'\n`,
      "utf8",
    );
    await fs.chmod(fakeNodePath, 0o755);
    process.execPath = fakeNodePath;

    const runtime = new toolSearch.ToolSearchRuntime(
      {},
      toolSearch.testing.resolveToolSearchConfig({}),
    );

    try {
      await toolSearch.testing.runCodeModeChild({
        code: "return 1;",
        config: toolSearch.testing.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-utf16-real",
        runtime,
      });
      throw new Error("Expected runCodeModeChild to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/tool_search_code child exited with 1/);
      // No isolated UTF-16 surrogates in the emitted error message.
      expect(message).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      // sliceUtf16Safe dropped the bisected astral character, leaving only the safe ASCII tail.
      expect(message.endsWith("a".repeat(499))).toBe(true);
    } finally {
      process.execPath = originalExecPath;
      await fs.rm(tempDir, { recursive: true, force: true });
      toolSearch.testing.setToolSearchCodeModeSupportedForTest(undefined);
      toolSearch.testing.setToolSearchMinCodeTimeoutMsForTest(undefined);
    }
  });
});
