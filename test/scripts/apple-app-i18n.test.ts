import { describe, expect, it } from "vitest";
import { checkAppleAppI18n } from "../../scripts/apple-app-i18n.ts";

describe("Apple app i18n catalogs", () => {
  it("keeps phased source coverage complete for every native locale", async () => {
    await expect(checkAppleAppI18n()).resolves.toBeUndefined();
  });
});
