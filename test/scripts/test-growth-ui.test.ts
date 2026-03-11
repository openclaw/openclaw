import { describe, expect, it } from "vitest";
import { buildGrowthUiEnv, resolveGrowthUiTempRoot } from "../../scripts/test-growth-ui.mjs";

describe("test-growth-ui", () => {
  it("falls back to /tmp on linux when Windows temp paths leak into the environment", () => {
    expect(
      resolveGrowthUiTempRoot(
        {
          TEMP: "/mnt/c/Users/yui/AppData/Local/Temp/OwmMGY8uyl_pto-YhLdo0",
        },
        "linux",
      ),
    ).toBe("/tmp");
  });

  it("preserves an explicit safe temp root on linux", () => {
    expect(
      buildGrowthUiEnv(
        {
          TMPDIR: "/tmp/openclaw-growth-ui",
          TEMP: "/mnt/c/Users/yui/AppData/Local/Temp/ignored",
        },
        "linux",
      ),
    ).toMatchObject({
      TMPDIR: "/tmp/openclaw-growth-ui",
      TMP: "/tmp/openclaw-growth-ui",
      TEMP: "/tmp/openclaw-growth-ui",
    });
  });

  it("keeps Windows temp paths unchanged on win32", () => {
    expect(
      buildGrowthUiEnv(
        {
          TEMP: "C:\\Users\\yui\\AppData\\Local\\Temp\\openclaw",
        },
        "win32",
      ),
    ).toMatchObject({
      TMPDIR: "C:\\Users\\yui\\AppData\\Local\\Temp\\openclaw",
      TMP: "C:\\Users\\yui\\AppData\\Local\\Temp\\openclaw",
      TEMP: "C:\\Users\\yui\\AppData\\Local\\Temp\\openclaw",
    });
  });
});
