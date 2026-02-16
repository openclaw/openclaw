import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "./invoke.js";
import { buildNodeInvokeResultParams } from "./runner.js";

describe("node-host sanitizeEnv", () => {
  it("ignores PATH overrides", () => {
    const prev = process.env.PATH;
    process.env.PATH = "/usr/bin";
    try {
      const env = sanitizeEnv({ PATH: "/tmp/evil:/usr/bin" }) ?? {};
      expect(env.PATH).toBe("/usr/bin");
    } finally {
      if (prev === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = prev;
      }
    }
  });

  it("blocks dangerous env keys/prefixes", () => {
    const prevPythonPath = process.env.PYTHONPATH;
    const prevLdPreload = process.env.LD_PRELOAD;
    try {
      delete process.env.PYTHONPATH;
      delete process.env.LD_PRELOAD;
      const env =
        sanitizeEnv({
          PYTHONPATH: "/tmp/pwn",
          LD_PRELOAD: "/tmp/pwn.so",
          FOO: "bar",
        }) ?? {};
      expect(env.FOO).toBe("bar");
      expect(env.PYTHONPATH).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
    } finally {
      if (prevPythonPath === undefined) {
        delete process.env.PYTHONPATH;
      } else {
        process.env.PYTHONPATH = prevPythonPath;
      }
      if (prevLdPreload === undefined) {
        delete process.env.LD_PRELOAD;
      } else {
        process.env.LD_PRELOAD = prevLdPreload;
      }
    }
  });
});

describe("buildNodeInvokeResultParams", () => {
  it("omits optional fields when null/undefined", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-1", nodeId: "node-1", command: "system.run" },
      { ok: true, payloadJSON: null, error: null },
    );

    expect(params).toEqual({ id: "invoke-1", nodeId: "node-1", ok: true });
    expect("payloadJSON" in params).toBe(false);
    expect("error" in params).toBe(false);
  });

  it("includes payloadJSON when provided", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-2", nodeId: "node-2", command: "system.run" },
      { ok: true, payloadJSON: '{"ok":true}' },
    );

    expect(params.payloadJSON).toBe('{"ok":true}');
  });

  it("includes payload when provided", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-3", nodeId: "node-3", command: "system.run" },
      { ok: false, payload: { reason: "bad" } },
    );

    expect(params.payload).toEqual({ reason: "bad" });
  });
});
