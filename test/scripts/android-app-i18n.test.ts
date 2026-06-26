import { describe, expect, it } from "vitest";
import { checkAndroidAppI18n } from "../../scripts/android-app-i18n.ts";

describe("Android app i18n resources", () => {
  it("keeps Russian and Hindi resource keys aligned with English", async () => {
    await expect(checkAndroidAppI18n()).resolves.toBeUndefined();
  });
});
