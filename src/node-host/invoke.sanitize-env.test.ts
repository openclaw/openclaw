import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "./invoke.js";

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
