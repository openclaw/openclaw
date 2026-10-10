import { describe, expect, it } from "vitest";
import { SessionSchema } from "../config/zod-schema.session-config.js";
import { resolveSessionCommunicationPolicy } from "./communication-policy.js";

describe("session communication defaults", () => {
  it("preserves existing behavior and inherits each direction independently", () => {
    expect(resolveSessionCommunicationPolicy({ config: {} })).toEqual({
      send: "always",
      receive: "always",
    });
    const config = { session: { communication: { send: "never", receive: "ask" } } } as const;
    expect(resolveSessionCommunicationPolicy({ config })).toEqual({
      send: "never",
      receive: "ask",
    });
    const entry = { communication: { send: "always" } } as const;
    expect(resolveSessionCommunicationPolicy({ config, entry })).toEqual({
      send: "always",
      receive: "ask",
    });
    expect(
      resolveSessionCommunicationPolicy({
        config: { session: { communication: { send: "ask", receive: "never" } } },
        entry,
      }),
    ).toEqual({ send: "always", receive: "never" });
  });

  it("validates configured choices without materializing defaults", () => {
    expect(SessionSchema.parse({ communication: { receive: "ask" } })).toEqual({
      communication: { receive: "ask" },
    });
    for (const communication of [
      { send: "allow" },
      { receive: null },
      { receive: "inherit" },
      { unknown: true },
    ]) {
      expect(SessionSchema.safeParse({ communication }).success).toBe(false);
    }
  });
});
