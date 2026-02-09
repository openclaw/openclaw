import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createShouldEmitToolResult } from "./agent-runner-helpers.js";

describe("createShouldEmitToolResult", () => {
  it("defaults to emitting tool results for group sessions", () => {
    const shouldEmit = createShouldEmitToolResult({
      sessionKey: "agent:main:telegram:group:-100123",
      resolvedVerboseLevel: "off",
    });
    expect(shouldEmit()).toBe(true);
  });

  it("honors explicit verbose off in group session store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-verbose-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-100123";
    fs.writeFileSync(
      storePath,
      JSON.stringify({ [sessionKey]: { verboseLevel: "off", updatedAt: Date.now() } }),
      "utf-8",
    );

    const shouldEmit = createShouldEmitToolResult({
      sessionKey,
      storePath,
      resolvedVerboseLevel: "on",
    });

    expect(shouldEmit()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inherits verbose off from parent group session for topic/thread keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-verbose-parent-"));
    const storePath = path.join(dir, "sessions.json");
    const parentKey = "agent:main:telegram:group:-100123";
    const topicKey = "agent:main:telegram:group:-100123:topic:777";
    fs.writeFileSync(
      storePath,
      JSON.stringify({ [parentKey]: { verboseLevel: "off", updatedAt: Date.now() } }),
      "utf-8",
    );

    const shouldEmit = createShouldEmitToolResult({
      sessionKey: topicKey,
      storePath,
      resolvedVerboseLevel: "on",
    });

    expect(shouldEmit()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("respects verbose off for non-group sessions", () => {
    const shouldEmit = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      resolvedVerboseLevel: "off",
    });
    expect(shouldEmit()).toBe(false);
  });
});
