import { expect, it } from "vitest";
import { bareNameAddress, resolveBrowserAddressInput } from "./browser-url.ts";

// Chromium's URL parser accepts spaces in a host ("https://a b/" becomes
// "https://a%20b/"), unlike Node's, so this runs in the real browser.
it("offers Go to only for text that could be a host", () => {
  expect(bareNameAddress("openclaw browser panel search")).toBeNull();
  expect(bareNameAddress("devbox docs/a")).toBeNull();
  expect(bareNameAddress("devbox")).toBe("https://devbox/");
  expect(bareNameAddress("devbox/a b")).toBe("https://devbox/a%20b");
  expect(resolveBrowserAddressInput("openclaw browser panel search")).toBe(
    "https://www.google.com/search?q=openclaw+browser+panel+search",
  );
});
