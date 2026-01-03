import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import type { ClawdisConfig } from "../config/config.js";
import {
  extractHookToken,
  normalizeAgentPayload,
  normalizeWakePayload,
  resolveHooksConfig,
} from "./hooks.js";

describe("gateway hooks helpers", () => {
  test("resolveHooksConfig normalizes paths + requires token", () => {
    const base = {
      hooks: {
        enabled: true,
        token: "secret",
        path: "hooks///",
      },
    } as ClawdisConfig;
    const resolved = resolveHooksConfig(base);
    expect(resolved?.basePath).toBe("/hooks");
    expect(resolved?.token).toBe("secret");
  });

  test("resolveHooksConfig rejects root path", () => {
    const cfg = {
      hooks: { enabled: true, token: "x", path: "/" },
    } as ClawdisConfig;
    expect(() => resolveHooksConfig(cfg)).toThrow("hooks.path may not be '/'");
  });

  test("extractHookToken prefers bearer > header > query", () => {
    const req = {
      headers: {
        authorization: "Bearer top",
        "x-clawdis-token": "header",
      },
    } as unknown as IncomingMessage;
    const url = new URL("http://localhost/hooks/wake?token=query");
    expect(extractHookToken(req, url)).toBe("top");

    const req2 = {
      headers: { "x-clawdis-token": "header" },
    } as unknown as IncomingMessage;
    expect(extractHookToken(req2, url)).toBe("header");

    const req3 = { headers: {} } as unknown as IncomingMessage;
    expect(extractHookToken(req3, url)).toBe("query");
  });

  test("normalizeWakePayload trims + validates", () => {
    expect(normalizeWakePayload({ text: "  hi " })).toEqual({
      ok: true,
      value: { text: "hi", mode: "now" },
    });
    expect(normalizeWakePayload({ text: "  ", mode: "now" }).ok).toBe(false);
  });

  test("normalizeAgentPayload defaults + validates channel", () => {
    const ok = normalizeAgentPayload(
      { message: "hello" },
      { idFactory: () => "fixed" },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.sessionKey).toBe("hook:fixed");
      expect(ok.value.channel).toBe("last");
      expect(ok.value.name).toBe("Hook");
    }

    const imsg = normalizeAgentPayload(
      { message: "yo", channel: "imsg" },
      { idFactory: () => "x" },
    );
    expect(imsg.ok).toBe(true);
    if (imsg.ok) {
      expect(imsg.value.channel).toBe("imessage");
    }

    const bad = normalizeAgentPayload({ message: "yo", channel: "sms" });
    expect(bad.ok).toBe(false);
  });
});
