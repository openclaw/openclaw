// Tests for WorkspaceObserver.
import { describe, expect, it } from "vitest";
import { EvidenceRecordSchema } from "../config/zod-schema.registry-validation.js";
import { observeWorkspace } from "./workspace-observer.js";

const FIXED_TIME = "2026-07-18T12:00:00.000Z";
const now = () => FIXED_TIME;

describe("WorkspaceObserver", () => {
  it("workspace present", () => {
    const result = observeWorkspace(
      () => ({ agents: { defaults: { workspace: "C:\\Users\\test\\workspace" } } }),
      { now },
    );
    expect(result.present).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.workspace).toBe("C:\\Users\\test\\workspace");
  });

  it("workspace absent", () => {
    const result = observeWorkspace(() => ({ agents: { defaults: {} } }), { now });
    expect(result.present).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.workspace).toBeNull();
  });

  it("invalid workspace type (number instead of string)", () => {
    const result = observeWorkspace(() => ({ agents: { defaults: { workspace: 123 } } }), { now });
    expect(result.present).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("string");
  });

  it("unreadable source (parser throws)", () => {
    const result = observeWorkspace(
      () => {
        throw new Error("Parse error: invalid JSON");
      },
      { now },
    );
    expect(result.present).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("Parse error");
  });

  it("parser error produces evidence", () => {
    const result = observeWorkspace(
      () => {
        throw new Error("SyntaxError");
      },
      { now },
    );
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0].notes).toContain("SyntaxError");
  });

  it("no silent fallback when workspace is absent", () => {
    const result = observeWorkspace(() => ({ agents: { defaults: {} } }), { now });
    expect(result.workspace).toBeNull();
    expect(result.present).toBe(false);
    // Should not fall back to some default
  });

  it("no config mutation (parser is read-only)", () => {
    const config = { agents: { defaults: { workspace: "/test/path" } } };
    observeWorkspace(() => config, { now });
    // Config should be unchanged
    expect(config.agents.defaults.workspace).toBe("/test/path");
    expect(Object.keys(config.agents.defaults)).toEqual(["workspace"]);
  });

  it("evidence validates against Phase 4F1 schema", () => {
    const result = observeWorkspace(() => ({ agents: { defaults: { workspace: "/test" } } }), {
      now,
    });
    for (const evidence of result.evidence) {
      const validation = EvidenceRecordSchema.safeParse(evidence);
      expect(validation.success).toBe(true);
    }
  });

  it("Windows path preserved", () => {
    const winPath = "C:\\Users\\maicon\\.openclaw\\workspace";
    const result = observeWorkspace(() => ({ agents: { defaults: { workspace: winPath } } }), {
      now,
    });
    expect(result.workspace).toBe(winPath);
  });

  it("unknown fields ignored", () => {
    const result = observeWorkspace(
      () => ({
        agents: {
          defaults: {
            workspace: "/test",
            unknownField: "ignored",
            anotherUnknown: 42,
          },
        },
        unknownTopLevel: "also ignored",
      }),
      { now },
    );
    expect(result.present).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.workspace).toBe("/test");
  });

  it("empty string workspace is invalid", () => {
    const result = observeWorkspace(() => ({ agents: { defaults: { workspace: "  " } } }), { now });
    expect(result.present).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("empty");
  });

  it("agents section missing", () => {
    const result = observeWorkspace(() => ({ gateway: { port: 18789 } }), { now });
    expect(result.present).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("defaults section missing", () => {
    const result = observeWorkspace(() => ({ agents: { list: [] } }), { now });
    expect(result.present).toBe(false);
    expect(result.valid).toBe(false);
  });
});
