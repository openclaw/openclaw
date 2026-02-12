import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config irc", () => {
  it("accepts basic irc config", () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          host: "irc.libera.chat",
          nick: "openclaw-bot",
          channels: ["#openclaw"],
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.config.channels?.irc?.host).toBe("irc.libera.chat");
    expect(res.config.channels?.irc?.nick).toBe("openclaw-bot");
  });

  it('rejects irc.dmPolicy="open" without allowFrom "*"', () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          dmPolicy: "open",
          allowFrom: ["alice"],
        },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.issues[0]?.path).toBe("channels.irc.allowFrom");
  });

  it('accepts irc.dmPolicy="open" with allowFrom "*"', () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.config.channels?.irc?.dmPolicy).toBe("open");
  });

  it("accepts mixed allowFrom value types for IRC", () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          allowFrom: [12345, "alice"],
          groupAllowFrom: [67890, "alice!ident@example.org"],
          groups: {
            "#ops": {
              allowFrom: [42, "alice"],
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.config.channels?.irc?.allowFrom).toEqual([12345, "alice"]);
    expect(res.config.channels?.irc?.groupAllowFrom).toEqual([67890, "alice!ident@example.org"]);
    expect(res.config.channels?.irc?.groups?.["#ops"]?.allowFrom).toEqual([42, "alice"]);
  });

  it("rejects nickserv register without registerEmail", () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          nickserv: {
            register: true,
            password: "secret",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.issues[0]?.path).toBe("channels.irc.nickserv.registerEmail");
  });

  it("accepts nickserv register with password and registerEmail", () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          nickserv: {
            register: true,
            password: "secret",
            registerEmail: "bot@example.com",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.config.channels?.irc?.nickserv?.register).toBe(true);
  });

  it("accepts nickserv register with registerEmail only (password may come from env)", () => {
    const res = validateConfigObject({
      channels: {
        irc: {
          nickserv: {
            register: true,
            registerEmail: "bot@example.com",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
