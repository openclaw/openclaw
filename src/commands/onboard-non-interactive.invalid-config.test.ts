import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  runNonInteractiveLocalSetup: vi.fn(async () => {}),
  runNonInteractiveRemoteSetup: vi.fn(async () => {}),
}));

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("./onboard-non-interactive/local.js", () => ({
  runNonInteractiveLocalSetup: mocks.runNonInteractiveLocalSetup,
}));

vi.mock("./onboard-non-interactive/remote.js", () => ({
  runNonInteractiveRemoteSetup: mocks.runNonInteractiveRemoteSetup,
}));

import { runNonInteractiveSetup } from "./onboard-non-interactive.js";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

describe("runNonInteractiveSetup invalid config handling", () => {
  it("includes config issue details before exiting", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      sourceConfig: {},
      issues: [
        {
          path: "",
          message: "JSON5 parse failed: JSON5: invalid character '}' at 2:20",
        },
      ],
    });

    await runNonInteractiveSetup({ nonInteractive: true, acceptRisk: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      [
        "Config invalid.",
        "Issues: <root>: JSON5 parse failed: JSON5: invalid character '}' at 2:20",
        "Run `openclaw doctor` to repair it, then re-run setup.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNonInteractiveLocalSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveRemoteSetup).not.toHaveBeenCalled();
  });
});
