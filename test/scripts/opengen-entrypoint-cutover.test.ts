import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("opengen entrypoint cutover", () => {
  it("uses next console as default web start path", () => {
    const script = fs.readFileSync("scripts/start-web.sh", "utf8");
    expect(script).toContain("pnpm opengen:dev");
  });
});
