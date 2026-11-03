import path from "node:path";
import { expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

// mock-isolation: The built CLI path must never load source TUI fixture entrypoints.
vi.mock("./tui-pty-runtime-test-support.js", () => {
  throw new Error("built CLI must not load source TUI fixtures");
});

it("launches the built CLI without loading source TUI fixtures", async () => {
  await withEnvAsync({ OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1" }, async () => {
    const { buildTuiProcessArgs } = await import("./tui-pty-process-test-support.js");
    expect(await buildTuiProcessArgs(["chat", "--local"])).toEqual([
      path.join(process.cwd(), "openclaw.mjs"),
      "chat",
      "--local",
    ]);
  });
});
