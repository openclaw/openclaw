import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";

describe("Code Mode config schema", () => {
  it("accepts Code Mode config in the runtime zod schema", () => {
    expect(ToolsSchema.parse({ codeMode: true })?.codeMode).toBe(true);
    expect(
      ToolsSchema.parse({
        codeMode: {
          enabled: true,
          executor: "quickjs",
          mode: "only",
          timeoutMs: 5000,
          memoryLimitBytes: 67_108_864,
          maxOutputBytes: 65_536,
          maxSnapshotBytes: 10_485_760,
          maxPendingToolCalls: 8,
          snapshotTtlSeconds: 900,
          searchDefaultLimit: 4,
          maxSearchLimit: 12,
        },
      })?.codeMode,
    ).toEqual({
      enabled: true,
      executor: "quickjs",
      mode: "only",
      timeoutMs: 5000,
      memoryLimitBytes: 67_108_864,
      maxOutputBytes: 65_536,
      maxSnapshotBytes: 10_485_760,
      maxPendingToolCalls: 8,
      snapshotTtlSeconds: 900,
      searchDefaultLimit: 4,
      maxSearchLimit: 12,
    });
    expect(
      ToolsSchema.safeParse({
        codeMode: {
          enabled: true,
          executor: "unsupported",
        },
      }).success,
    ).toBe(false);
    expect(ToolsSchema.parse({ codeMode: { executor: "node" } })?.codeMode).toEqual({
      executor: "node",
    });
    expect(ToolsSchema.safeParse({ codeMode: { runtime: "quickjs-wasi" } }).success).toBe(false);
  });

  it("accepts the Code Mode auto tier and rejects unknown tiers", () => {
    expect(ToolsSchema.parse({ codeMode: "auto" })?.codeMode).toBe("auto");
    expect(ToolsSchema.parse({ codeMode: false })?.codeMode).toBe(false);
    expect(ToolsSchema.parse({ codeMode: { enabled: "auto" } })?.codeMode).toEqual({
      enabled: "auto",
    });
    expect(ToolsSchema.safeParse({ codeMode: "on" }).success).toBe(false);
    expect(ToolsSchema.safeParse({ codeMode: { enabled: "always" } }).success).toBe(false);
    expect(ToolsSchema.safeParse({ codeMode: { languages: ["javascript"] } }).success).toBe(false);
  });
});
