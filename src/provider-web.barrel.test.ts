import { describe, expect, it } from "vitest";

import * as mod from "./provider-web.js";

describe("provider-web barrel", () => {
  it("exports the expected web helpers", () => {
    expect(mod.createWaSocket).toBeTypeOf("function");
    expect(mod.loginWeb).toBeTypeOf("function");
    expect(mod.monitorWebProvider).toBeTypeOf("function");
    expect(mod.sendMessageWeb).toBeTypeOf("function");
    expect(mod.monitorWebInbox).toBeTypeOf("function");
    expect(mod.pickProvider).toBeTypeOf("function");
    expect(mod.WA_WEB_AUTH_DIR).toBeTruthy();
  });
});
