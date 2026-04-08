import { describe, expect, it } from "vitest";
import { IrcConfigSchema } from "./zod-schema.providers-core.js";

function expectValidConfig(result: ReturnType<typeof IrcConfigSchema.safeParse>) {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected config to be valid");
  }
  return result.data;
}

function expectInvalidConfig(result: ReturnType<typeof IrcConfigSchema.safeParse>) {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected config to be invalid");
  }
  return result.error.issues;
}

describe("config irc", () => {
  it("accepts basic irc config", () => {
    const res = IrcConfigSchema.safeParse({
      host: "irc.libera.chat",
      nick: "openclaw-bot",
      channels: ["#openclaw"],
    });

    const config = expectValidConfig(res);
    expect(config.host).toBe("irc.libera.chat");
    expect(config.nick).toBe("openclaw-bot");
  });

  it('rejects irc.dmPolicy="open" without allowFrom "*"', () => {
    const res = IrcConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["alice"],
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('accepts irc.dmPolicy="open" with allowFrom "*"', () => {
    const res = IrcConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });

    const config = expectValidConfig(res);
    expect(config.dmPolicy).toBe("open");
  });

  it("accepts mixed allowFrom value types for IRC", () => {
    const res = IrcConfigSchema.safeParse({
      allowFrom: [12345, "alice"],
      groupAllowFrom: [67890, "alice!ident@example.org"],
      groups: {
        "#ops": {
          allowFrom: [42, "alice"],
        },
      },
    });

    const config = expectValidConfig(res);
    expect(config.allowFrom).toEqual([12345, "alice"]);
    expect(config.groupAllowFrom).toEqual([67890, "alice!ident@example.org"]);
    expect(config.groups?.["#ops"]?.allowFrom).toEqual([42, "alice"]);
  });

  it("rejects nickserv register without registerEmail", () => {
    const res = IrcConfigSchema.safeParse({
      nickserv: {
        register: true,
        password: "secret",
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path.join(".")).toBe("nickserv.registerEmail");
  });

  it("accepts nickserv register with password and registerEmail", () => {
    const res = IrcConfigSchema.safeParse({
      nickserv: {
        register: true,
        password: "secret",
        registerEmail: "bot@example.com",
      },
    });

    const config = expectValidConfig(res);
    expect(config.nickserv?.register).toBe(true);
  });

  it("accepts nickserv register with registerEmail only (password may come from env)", () => {
    const res = IrcConfigSchema.safeParse({
      nickserv: {
        register: true,
        registerEmail: "bot@example.com",
      },
    });

    expectValidConfig(res);
  });
});
