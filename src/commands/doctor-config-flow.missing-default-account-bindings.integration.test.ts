import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../terminal/note.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

vi.mock("./doctor-legacy-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-legacy-config.js")>();
  return {
    ...actual,
    normalizeCompatibilityConfigValues: (cfg: unknown) => ({
      config: cfg,
      changes: [],
    }),
  };
});

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

const noteSpy = vi.mocked(note);

describe("doctor missing default account binding warning", () => {
  beforeEach(() => {
    noteSpy.mockClear();
  });

  it("emits a doctor warning when named accounts have no valid account-scoped bindings", async () => {
    await withEnvAsync(
      {
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN_FILE: undefined,
      },
      async () => {
        await runDoctorConfigWithInput({
          config: {
            channels: {
              telegram: {
                accounts: {
                  alerts: {},
                  work: {},
                },
              },
            },
            bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
          },
          run: loadAndMaybeMigrateDoctorConfig,
        });
      },
    );

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("channels.telegram: accounts.default is missing"),
      "Doctor warnings",
    );
  });

  it("emits a warning when multiple accounts have no explicit default", async () => {
    await withEnvAsync(
      {
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN_FILE: undefined,
      },
      async () => {
        await runDoctorConfigWithInput({
          config: {
            channels: {
              telegram: {
                accounts: {
                  alerts: {},
                  work: {},
                },
              },
            },
          },
          run: loadAndMaybeMigrateDoctorConfig,
        });
      },
    );

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "channels.telegram: multiple accounts are configured but no explicit default is set",
      ),
      "Doctor warnings",
    );
  });

  it("emits a warning when defaultAccount does not match configured accounts", async () => {
    await withEnvAsync(
      {
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN_FILE: undefined,
      },
      async () => {
        await runDoctorConfigWithInput({
          config: {
            channels: {
              telegram: {
                defaultAccount: "missing",
                accounts: {
                  alerts: {},
                  work: {},
                },
              },
            },
          },
          run: loadAndMaybeMigrateDoctorConfig,
        });
      },
    );

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'channels.telegram: defaultAccount is set to "missing" but does not match configured accounts',
      ),
      "Doctor warnings",
    );
  });
});
