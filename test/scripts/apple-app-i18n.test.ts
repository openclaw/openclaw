import { describe, expect, it } from "vitest";
import { checkAppleAppI18n } from "../../scripts/apple-app-i18n.ts";

describe("Apple app i18n catalogs", () => {
  it("keeps the checked-in Russian and Hindi catalog entries complete", async () => {
    await expect(checkAppleAppI18n()).resolves.toBeUndefined();
  });
});
