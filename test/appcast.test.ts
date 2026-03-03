import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectAppcastSparkleVersionErrors } from "../scripts/release-check.ts";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

describe("appcast.xml", () => {
  it("passes release-check sparkle version validation", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    expect(collectAppcastSparkleVersionErrors(appcast)).toEqual([]);
  });
});
