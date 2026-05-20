import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function readConfiguredMode(envOverrides?: Record<string, string>): string {
  const env = { ...process.env, ...envOverrides };
  if (!envOverrides || !("FS_SAFE_PYTHON_MODE" in envOverrides)) {
    delete env.FS_SAFE_PYTHON_MODE;
  }
  if (!envOverrides || !("OPENCLAW_FS_SAFE_PYTHON_MODE" in envOverrides)) {
    delete env.OPENCLAW_FS_SAFE_PYTHON_MODE;
  }

  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      [
        'import "./src/infra/fs-safe-defaults.ts";',
        'import { getFsSafePythonConfig } from "@openclaw/fs-safe/config";',
        "console.log(getFsSafePythonConfig().mode);",
      ].join("\n"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    },
  ).trim();
}

describe("fs-safe defaults", () => {
  it("uses fs-safe Python auto mode by default in OpenClaw", () => {
    expect(readConfiguredMode()).toBe("auto");
  });

  it("lets fs-safe env mode overrides opt back into the helper", () => {
    expect(readConfiguredMode({ FS_SAFE_PYTHON_MODE: "require" })).toBe("require");
  });

  it("honors the OpenClaw-specific env mode override", () => {
    expect(readConfiguredMode({ OPENCLAW_FS_SAFE_PYTHON_MODE: "auto" })).toBe("auto");
  });
});
