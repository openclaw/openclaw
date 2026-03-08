import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("ignores unknown keys with warnings instead of failing startup", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        nope: true,
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: ["+1234567890"],
          },
        },
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const cfg = loadConfig();
        expect(cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
        expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+1234567890"]);
        expect(warnSpy).toHaveBeenCalled();
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).toContain("unknown config key ignored");
      },
    );
  });

  it("still throws INVALID_CONFIG for invalid known fields", async () => {
    await withTempHomeConfig(
      {
        gateway: { port: -1 },
        agents: { list: [{ id: "main" }] },
      },
      async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let thrown: unknown;
        try {
          loadConfig();
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
        expect(errorSpy).toHaveBeenCalled();
      },
    );
  });

  it("still loads valid security settings unchanged", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: ["+1234567890"],
          },
        },
      },
      async () => {
        const cfg = loadConfig();
        expect(cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
        expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+1234567890"]);
      },
    );
  });
});
