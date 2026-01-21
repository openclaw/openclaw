import { describe, expect, test } from "vitest";

import { buildNodeInvokeResultParams } from "./runner.js";

describe("buildNodeInvokeResultParams", () => {
  test("omits optional fields when null/undefined", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-1", nodeId: "node-1", command: "system.run" },
      { ok: true, payloadJSON: null, error: null },
    );

    expect(params).toEqual({ id: "invoke-1", nodeId: "node-1", ok: true });
    expect("payloadJSON" in params).toBe(false);
    expect("error" in params).toBe(false);
  });

  test("includes payloadJSON when provided", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-2", nodeId: "node-2", command: "system.run" },
      { ok: true, payloadJSON: '{"ok":true}' },
    );

    expect(params.payloadJSON).toBe('{"ok":true}');
  });

  test("includes payload when provided", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-3", nodeId: "node-3", command: "system.run" },
      { ok: false, payload: { reason: "bad" } },
    );

    expect(params.payload).toEqual({ reason: "bad" });
  });
});
