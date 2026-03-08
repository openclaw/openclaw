import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("throws INVALID_CONFIG instead of returning an empty config", async () => {
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
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        let thrown: unknown;
        try {
          loadConfig();
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
        expect(spy).toHaveBeenCalled();
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
