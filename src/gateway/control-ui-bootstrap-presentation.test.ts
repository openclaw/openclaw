import { describe, expect, it } from "vitest";
import { resolveControlUiBootstrapPresentation } from "./control-ui-bootstrap-presentation.js";

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
