import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

const { noteSpy } = vi.hoisted(() => ({
  noteSpy: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: noteSpy,
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

describe("doctor missing default account binding warning", () => {
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
});
