import { describe, expect, it } from "vitest";
import { isSignalSenderAllowed, resolveSignalSender } from "./identity.js";

describe("resolveSignalSender", () => {
  it("returns phone sender with uuid when both sourceNumber and sourceUuid are present", () => {
    const sender = resolveSignalSender({
      sourceNumber: "+15550001111",
      sourceUuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
      uuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
  });

  it("returns phone sender without uuid when sourceUuid is missing", () => {
    const sender = resolveSignalSender({ sourceNumber: "+15550001111" });
    expect(sender).toMatchObject({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
    });
    expect((sender as { uuid?: string }).uuid).toBeUndefined();
  });

  it("falls back to uuid sender when sourceNumber is absent", () => {
    const sender = resolveSignalSender({
      sourceUuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
  });

  it("returns null when neither identifier is present", () => {
    expect(resolveSignalSender({})).toBeNull();
  });
});

describe("isSignalSenderAllowed", () => {
  it("matches phone allowlist entry against phone sender", () => {
    const sender = { kind: "phone" as const, raw: "+15550001111", e164: "+15550001111" };
    expect(isSignalSenderAllowed(sender, ["+15550001111"])).toBe(true);
    expect(isSignalSenderAllowed(sender, ["+15559999999"])).toBe(false);
  });

  it("matches uuid allowlist entry against uuid sender", () => {
    const sender = { kind: "uuid" as const, raw: "cb274c30-17ce-49ee-97c6-55dd9ce14595" };
    expect(isSignalSenderAllowed(sender, ["uuid:cb274c30-17ce-49ee-97c6-55dd9ce14595"])).toBe(true);
    expect(isSignalSenderAllowed(sender, ["uuid:00000000-0000-0000-0000-000000000000"])).toBe(
      false,
    );
  });

  it("matches uuid allowlist entry against phone sender that carries a uuid", () => {
    // This is the critical cross-kind scenario: allowlist uses uuid: format
    // but resolveSignalSender returns kind=phone when sourceNumber is present.
    const sender = {
      kind: "phone" as const,
      raw: "+15550001111",
      e164: "+15550001111",
      uuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    };
    expect(isSignalSenderAllowed(sender, ["uuid:cb274c30-17ce-49ee-97c6-55dd9ce14595"])).toBe(true);
  });

  it("rejects uuid allowlist entry when phone sender has no uuid", () => {
    const sender = { kind: "phone" as const, raw: "+15550001111", e164: "+15550001111" };
    expect(isSignalSenderAllowed(sender, ["uuid:cb274c30-17ce-49ee-97c6-55dd9ce14595"])).toBe(
      false,
    );
  });

  it("allows wildcard (*)", () => {
    const sender = { kind: "phone" as const, raw: "+15550001111", e164: "+15550001111" };
    expect(isSignalSenderAllowed(sender, ["*"])).toBe(true);
  });

  it("returns false for empty allowlist", () => {
    const sender = { kind: "phone" as const, raw: "+15550001111", e164: "+15550001111" };
    expect(isSignalSenderAllowed(sender, [])).toBe(false);
  });
});
