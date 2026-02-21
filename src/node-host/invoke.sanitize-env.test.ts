import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "./invoke.js";
import { buildNodeInvokeResultParams } from "./runner.js";

describe("node-host sanitizeEnv", () => {
  it("ignores PATH overrides", () => {
    const prev = process.env.PATH;
    process.env.PATH = "/usr/bin";
    try {
      const env = sanitizeEnv({ PATH: "/tmp/evil:/usr/bin" });
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
    const prevBashEnv = process.env.BASH_ENV;
    try {
      delete process.env.PYTHONPATH;
      delete process.env.LD_PRELOAD;
      delete process.env.BASH_ENV;
      const env = sanitizeEnv({
        PYTHONPATH: "/tmp/pwn",
        LD_PRELOAD: "/tmp/pwn.so",
        BASH_ENV: "/tmp/pwn.sh",
        FOO: "bar",
      });
      expect(env.FOO).toBe("bar");
      expect(env.PYTHONPATH).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.BASH_ENV).toBeUndefined();
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
      if (prevBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = prevBashEnv;
      }
    }
  });

  it("drops dangerous inherited env keys even without overrides", () => {
    const prevPath = process.env.PATH;
    const prevBashEnv = process.env.BASH_ENV;
    try {
      process.env.PATH = "/usr/bin:/bin";
      process.env.BASH_ENV = "/tmp/pwn.sh";
      const env = sanitizeEnv(undefined);
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.BASH_ENV).toBeUndefined();
    } finally {
      if (prevPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = prevPath;
      }
      if (prevBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = prevBashEnv;
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
