import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("commands-approve import boundary", () => {
  it("uses the lazy telegram facade instead of the concrete extension barrel", () => {
    const source = readFileSync(new URL("./commands-approve.ts", import.meta.url), "utf8");

    expect(source).toContain('from "../../plugin-sdk/telegram-surface.js"');
    expect(source).not.toContain('from "../../../extensions/telegram/api.js"');
  });
});
