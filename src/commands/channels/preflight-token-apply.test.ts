import { describe, expect, it, vi } from "vitest";
import {
  preflightChannelConfigWrite,
  preflightChannelConfigWriteBatch,
} from "./preflight-token-apply.js";

describe("preflightChannelConfigWrite", () => {
  it("returns ok when prompter confirms", async () => {
    const result = await preflightChannelConfigWrite({
      channel: "telegram",
      accountId: "default",
      prompter: { confirm: vi.fn().mockResolvedValue(true) },
    });
    expect(result.ok).toBe(true);
  });

  it("returns not ok when prompter cancels", async () => {
    const result = await preflightChannelConfigWrite({
      channel: "telegram",
      accountId: "work",
      prompter: { confirm: vi.fn().mockResolvedValue(false) },
    });
    expect(result.ok).toBe(false);
    expect("reason" in result && result.reason).toContain("cancelled");
  });

  it("returns not ok when non-interactive and no confirmTarget", async () => {
    const result = await preflightChannelConfigWrite({
      channel: "telegram",
      accountId: "default",
    });
    expect(result.ok).toBe(false);
    expect("reason" in result && result.reason).toContain("--confirm-target");
  });

  it("returns ok when non-interactive with confirmTarget", async () => {
    const result = await preflightChannelConfigWrite({
      channel: "discord",
      accountId: "default",
      confirmTarget: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("preflightChannelConfigWriteBatch", () => {
  it("returns ok when prompter confirms", async () => {
    const result = await preflightChannelConfigWriteBatch({
      targets: [{ channel: "telegram", accountId: "default" }],
      prompter: { confirm: vi.fn().mockResolvedValue(true) },
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok for empty targets", async () => {
    const result = await preflightChannelConfigWriteBatch({
      targets: [],
      prompter: { confirm: vi.fn() },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result).toBeTruthy();
  });

  it("returns not ok when prompter cancels", async () => {
    const result = await preflightChannelConfigWriteBatch({
      targets: [{ channel: "telegram", accountId: "default" }],
      prompter: { confirm: vi.fn().mockResolvedValue(false) },
    });
    expect(result.ok).toBe(false);
  });
});
