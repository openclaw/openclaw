import { describe, expect, it } from "vitest";

import { runCommandWithTimeout } from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("passes env overrides to child", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        'process.stdout.write(process.env.CLAWDBOT_TEST_ENV ?? "")',
      ],
      {
        timeoutMs: 5_000,
        env: { CLAWDBOT_TEST_ENV: "ok" },
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });
});
