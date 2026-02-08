import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  loadAndMaybeMigrateDoctorConfig,
  restoreConfigEnvTemplates,
} from "./doctor-config-flow.js";

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

  it("restores env templates when repaired config omits the leaf key", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-live-secret" };
    const result = restoreConfigEnvTemplates({
      rawConfig: {
        models: {
          providers: {
            openai: {
              apiKey: "${OPENAI_API_KEY}",
            },
          },
        },
      },
      config: {
        models: {
          providers: {
            openai: {},
          },
        },
      } as never,
      env,
    });

    const apiKey = (
      (
        (
          result.models as {
            providers?: {
              openai?: { apiKey?: string };
            };
          }
        )?.providers ?? {}
      ).openai ?? {}
    ).apiKey;
    expect(apiKey).toBe("${OPENAI_API_KEY}");
  });

  it("does not restore env templates for unknown paths removed by doctor", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-live-secret" };
    const result = restoreConfigEnvTemplates({
      rawConfig: {
        gateway: {
          auth: {
            extra: "${OPENAI_API_KEY}",
          },
        },
      },
      config: {
        gateway: {
          auth: {},
        },
      } as never,
      env,
      blockedPaths: ["gateway.auth.extra"],
    });

    const extra = ((result.gateway as { auth?: { extra?: string } })?.auth ?? {}).extra;
    expect(extra).toBeUndefined();
  });
});
