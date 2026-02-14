import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("doctor config flow", () => {
  it("preserves invalid config for doctor repairs", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            gateway: { auth: { mode: "token", token: 123 } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });

      expect((result.cfg as Record<string, unknown>).gateway).toEqual({
        auth: { mode: "token", token: 123 },
      });
    });
  });

  it("drops unknown keys on repair", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            bridge: { bind: "auto" },
            gateway: { auth: { mode: "token", token: "ok", extra: true } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });

      const cfg = result.cfg as Record<string, unknown>;
      expect(cfg.bridge).toBeUndefined();
      expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
        mode: "token",
        token: "ok",
      });
    });
  });

  it("resolves Telegram @username allowFrom entries to numeric IDs on repair", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const u = String(url);
      const chatId = new URL(u).searchParams.get("chat_id") ?? "";
      const id =
        chatId.toLowerCase() === "@testuser"
          ? 111
          : chatId.toLowerCase() === "@groupuser"
            ? 222
            : chatId.toLowerCase() === "@topicuser"
              ? 333
              : chatId.toLowerCase() === "@accountuser"
                ? 444
                : null;
      return {
        ok: id != null,
        json: async () => (id != null ? { ok: true, result: { id } } : { ok: false }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              channels: {
                telegram: {
                  botToken: "123:abc",
                  allowFrom: ["@testuser"],
                  groupAllowFrom: ["groupUser"],
                  groups: {
                    "-100123": {
                      allowFrom: ["tg:@topicUser"],
                      topics: { "99": { allowFrom: ["@accountUser"] } },
                    },
                  },
                  accounts: {
                    alerts: { botToken: "456:def", allowFrom: ["@accountUser"] },
                  },
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const result = await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });

        const cfg = result.cfg as unknown as {
          channels: {
            telegram: {
              allowFrom: string[];
              groupAllowFrom: string[];
              groups: Record<
                string,
                { allowFrom: string[]; topics: Record<string, { allowFrom: string[] }> }
              >;
              accounts: Record<string, { allowFrom: string[] }>;
            };
          };
        };
        expect(cfg.channels.telegram.allowFrom).toEqual(["111"]);
        expect(cfg.channels.telegram.groupAllowFrom).toEqual(["222"]);
        expect(cfg.channels.telegram.groups["-100123"].allowFrom).toEqual(["333"]);
        expect(cfg.channels.telegram.groups["-100123"].topics["99"].allowFrom).toEqual(["444"]);
        expect(cfg.channels.telegram.accounts.alerts.allowFrom).toEqual(["444"]);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
