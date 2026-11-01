import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveControlUiBootstrapPresentation } from "./control-ui-bootstrap-presentation.js";

it.each([
  { readOnly: "1", notice: "  Edit in Console. ", enabled: true, guidance: "Edit in Console." },
  { nixMode: "1", notice: " ", enabled: true, guidance: undefined },
  { notice: "Edit in Console.", enabled: false, guidance: undefined },
])("reports the config write policy for %j", ({ readOnly, nixMode, notice, enabled, guidance }) => {
  vi.stubEnv("OPENCLAW_CONFIG_READONLY", readOnly);
  vi.stubEnv("OPENCLAW_NIX_MODE", nixMode);
  vi.stubEnv("OPENCLAW_CONFIG_READONLY_NOTICE", notice);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  expect(resolveControlUiBootstrapPresentation(undefined)).toMatchObject({
    configReadOnly: enabled,
    configReadOnlyNotice: guidance,
  });
});

describe("Control UI model defaults bootstrap", () => {
  it.each([undefined, "configured"] as const)(
    "projects %s without model restrictions",
    (newSessionModelDefaults) => {
      const result = resolveControlUiBootstrapPresentation({
        gateway: { controlUi: { newSessionModelDefaults } },
      });
      expect(result.newSessionModelDefaults).toBe(newSessionModelDefaults ?? "last-used");
      expect(result).not.toHaveProperty("modelSelectionPolicy");
    },
  );
});

it.each([undefined, false, true])("projects composer inference opt-in: %s", (enabled) => {
  expect(
    resolveControlUiBootstrapPresentation({
      gateway: { controlUi: { experimental: { composerPredictions: { enabled } } } },
    }).composerPredictionsEnabled,
  ).toBe(enabled === true);
});

it.each([undefined, false, true])(
  "projects the bubble lab only when enabled: %s",
  (chatBubbles) => {
    expect(
      resolveControlUiBootstrapPresentation({
        gateway: { controlUi: { experimental: { chatBubbles } } },
      }).chatBubblesEnabled,
    ).toBe(chatBubbles === true);
  },
);
