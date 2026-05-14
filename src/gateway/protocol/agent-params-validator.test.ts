import { describe, expect, it } from "vitest";
import { validateAgentParams } from "./index.js";

const minimal = {
  message: "hello",
  idempotencyKey: "evt-1",
} as const;

describe("validateAgentParams - paperclip + adapterMeta tolerance", () => {
  it("accepts the minimal canonical payload", () => {
    expect(validateAgentParams({ ...minimal })).toBe(true);
  });

  it("still requires message and idempotencyKey", () => {
    expect(validateAgentParams({ message: "hello" })).toBe(false);
    expect(validateAgentParams({ idempotencyKey: "evt-1" })).toBe(false);
    expect(validateAgentParams({})).toBe(false);
  });

  it("accepts the legacy root-level paperclip metadata field (compat alias)", () => {
    expect(
      validateAgentParams({
        ...minimal,
        paperclip: { rev: "3494e84", source: "heartbeat", attempt: 1 },
      }),
    ).toBe(true);
  });

  it("treats the paperclip alias as opaque (any JSON value)", () => {
    for (const value of [
      { nested: { fields: ["ok"] } },
      "string-payload",
      42,
      true,
      null,
      [{ k: "v" }],
    ]) {
      expect(validateAgentParams({ ...minimal, paperclip: value })).toBe(true);
    }
  });

  it("accepts adapterMeta with one or more adapter keys", () => {
    expect(
      validateAgentParams({
        ...minimal,
        adapterMeta: {
          paperclip: { rev: "3494e84", source: "heartbeat" },
          greptile: { workspaceId: "ws_42", queryId: "q_99" },
        },
      }),
    ).toBe(true);
  });

  it("accepts an empty adapterMeta and adapterMeta with primitive entry values", () => {
    expect(validateAgentParams({ ...minimal, adapterMeta: {} })).toBe(true);
    expect(
      validateAgentParams({
        ...minimal,
        adapterMeta: { custom: "v1", flag: true, count: 7 },
      }),
    ).toBe(true);
  });

  it("accepts both surfaces side by side (paperclip alias + adapterMeta.paperclip)", () => {
    expect(
      validateAgentParams({
        ...minimal,
        paperclip: { rev: "3494e84" },
        adapterMeta: { paperclip: { rev: "3494e84", source: "heartbeat" } },
      }),
    ).toBe(true);
  });

  it("rejects non-object adapterMeta", () => {
    for (const value of ["string", 1, true, null, [{ k: "v" }]]) {
      expect(validateAgentParams({ ...minimal, adapterMeta: value })).toBe(false);
    }
  });

  it("still rejects truly unknown root properties (additionalProperties guard intact)", () => {
    expect(validateAgentParams({ ...minimal, somethingElse: "x" })).toBe(false);
    expect(validateAgentParams({ ...minimal, idempotnecyKey: "typo" })).toBe(false);
  });
});
