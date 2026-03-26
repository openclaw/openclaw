import { describe, expect, it } from "vitest";
import {
  constrainTaskProfileToolPackToAvailableTools,
  resolveTaskProfileToolPack,
} from "./task-profile-tool-pack.js";

describe("resolveTaskProfileToolPack", () => {
  it("maps coding prompts to the coding tool profile", () => {
    expect(
      resolveTaskProfileToolPack({
        promptText: "Fix the TypeScript build error in src/version.ts",
      }),
    ).toEqual(
      expect.objectContaining({
        taskProfile: "coding",
        toolProfile: "coding",
      }),
    );
  });

  it("maps research prompts to a minimal pack plus web and memory tools", () => {
    expect(
      resolveTaskProfileToolPack({
        promptText: "Research the latest OpenClaw docs and summarize the key changes",
      }),
    ).toEqual(
      expect.objectContaining({
        taskProfile: "research",
        toolProfile: "minimal",
        alsoAllow: expect.arrayContaining(["web_search", "web_fetch", "browser", "memory_search"]),
      }),
    );
  });

  it("maps ops prompts to runtime-heavy tools", () => {
    expect(
      resolveTaskProfileToolPack({
        promptText: "Restart the gateway, inspect logs, and check cron status",
      }),
    ).toEqual(
      expect.objectContaining({
        taskProfile: "ops",
        toolProfile: "minimal",
        alsoAllow: expect.arrayContaining(["exec", "process", "gateway", "cron", "nodes"]),
      }),
    );
  });

  it("falls back to assistant pack for main/default sessions without stronger signals", () => {
    expect(
      resolveTaskProfileToolPack({
        sessionKey: "agent:default:main",
      }),
    ).toEqual(
      expect.objectContaining({
        taskProfile: "assistant",
        toolProfile: "minimal",
        alsoAllow: expect.arrayContaining(["message", "sessions_send", "web_search"]),
      }),
    );
  });

  it("constrains generated packs to currently available tools", () => {
    const constrained = constrainTaskProfileToolPackToAvailableTools(
      resolveTaskProfileToolPack({
        promptText: "Fix the TypeScript build error in src/version.ts",
      }),
      [
        "read",
        "write",
        "edit",
        "exec",
        "process",
        "web_search",
        "web_fetch",
        "memory_search",
        "memory_get",
      ],
    );

    expect(constrained.policy?.allow).toEqual([
      "read",
      "write",
      "edit",
      "exec",
      "process",
      "web_search",
      "web_fetch",
      "memory_search",
      "memory_get",
    ]);
    expect(constrained.policy?.allow).not.toContain("apply_patch");
    expect(constrained.policy?.allow).not.toContain("image");
    expect(constrained.policy?.allow).not.toContain("image_generate");
  });
});
