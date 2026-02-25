import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { sanitizeEnv } from "./invoke.js";
import { buildNodeInvokeResultParams } from "./runner.js";

describe("node-host sanitizeEnv", () => {
  it("ignores PATH overrides", () => {
    withEnv({ PATH: "/usr/bin" }, () => {
      const env = sanitizeEnv({ PATH: "/tmp/evil:/usr/bin" });
      expect(env.PATH).toBe("/usr/bin");
    });
  });

  it("blocks dangerous env keys/prefixes", () => {
    withEnv(
      { PYTHONPATH: undefined, LD_PRELOAD: undefined, BASH_ENV: undefined, SHELLOPTS: undefined },
      () => {
        const env = sanitizeEnv({
          PYTHONPATH: "/tmp/pwn",
          LD_PRELOAD: "/tmp/pwn.so",
          BASH_ENV: "/tmp/pwn.sh",
          SHELLOPTS: "xtrace",
          PS4: "$(touch /tmp/pwned)",
          FOO: "bar",
        });
        expect(env.FOO).toBe("bar");
        expect(env.PYTHONPATH).toBeUndefined();
        expect(env.LD_PRELOAD).toBeUndefined();
        expect(env.BASH_ENV).toBeUndefined();
        expect(env.SHELLOPTS).toBeUndefined();
        expect(env.PS4).toBeUndefined();
      },
    );
  });

  it("blocks dangerous override-only env keys", () => {
    withEnv({ HOME: "/Users/trusted", ZDOTDIR: "/Users/trusted/.zdot" }, () => {
      const env = sanitizeEnv({
        HOME: "/tmp/evil-home",
        ZDOTDIR: "/tmp/evil-zdotdir",
      });
      expect(env.HOME).toBe("/Users/trusted");
      expect(env.ZDOTDIR).toBe("/Users/trusted/.zdot");
    });
  });

  it("drops dangerous inherited env keys even without overrides", () => {
    withEnv({ PATH: "/usr/bin:/bin", BASH_ENV: "/tmp/pwn.sh" }, () => {
      const env = sanitizeEnv(undefined);
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.BASH_ENV).toBeUndefined();
    });
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
