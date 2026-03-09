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

  it("ignores unknown keys that include surrounding whitespace in the key name", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        " nope ": true,
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const cfg = loadConfig();
        expect(cfg.agents?.list?.[0]?.id).toBe("main");
        expect(warnSpy).toHaveBeenCalled();
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText).toContain('" nope "');
      },
    );
  });

  it("ignores unknown keys nested under union-backed object config values", async () => {
    await withTempHomeConfig(
      {
        agents: {
          list: [{ id: "main" }],
          defaults: {
            model: {
              primary: "gpt-4o-mini",
              extra: true,
            },
          },
        },
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const cfg = loadConfig();
        expect(cfg.agents?.defaults?.model).toEqual({
          primary: "gpt-4o-mini",
        });
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).toContain("unknown config key ignored");
        expect(warnedText).toContain("agents.defaults.model");
        expect(warnedText).toContain('"extra"');
      },
    );
  });

  it("does not strip valid keys from non-selected union branches", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        bindings: [
          {
            type: "acp",
            agentId: "main",
            match: {
              channel: "discord",
              peer: { kind: "direct", id: "user-1" },
            },
            acp: {
              mode: "persistent",
            },
            acpp: true,
          },
        ],
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const cfg = loadConfig();
        const binding = cfg.bindings?.[0] as {
          acp?: { mode?: string };
          acpp?: unknown;
        };
        expect(binding?.acp?.mode).toBe("persistent");
        expect(binding).not.toHaveProperty("acpp");
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).toContain("unknown config key ignored");
        expect(warnedText).toContain("bindings.0");
        expect(warnedText).toContain('"acpp"');
      },
    );
  });

  it("fails closed when ACP binding omits required type discriminator", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "discord",
              peer: { kind: "direct", id: "user-1" },
            },
            acp: {
              mode: "persistent",
            },
          },
        ],
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).not.toContain("unknown config key ignored");
      },
    );
  });

  it("fails closed when ACP binding has invalid known fields", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        bindings: [
          {
            type: "acp",
            agentId: "main",
            match: {
              channel: "discord",
              peer: { kind: "direct", id: "user-1" },
            },
            acp: {
              mode: "BAD",
            },
          },
        ],
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).not.toContain("unknown config key ignored");
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

  it("still throws INVALID_CONFIG for legacy keys before unknown-key stripping", async () => {
    await withTempHomeConfig(
      {
        agents: { list: [{ id: "main" }] },
        whatsapp: {
          allowFrom: ["+1234567890"],
        },
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).not.toContain("unknown config key ignored");
      },
    );
  });

  it("logs unknown-key warnings even when invalid known fields still fail closed", async () => {
    await withTempHomeConfig(
      {
        nope: true,
        gateway: { port: -1 },
        agents: { list: [{ id: "main" }] },
      },
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        const warnedText = warnSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
        expect(warnedText.toLowerCase()).toContain("unknown config key ignored");
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
