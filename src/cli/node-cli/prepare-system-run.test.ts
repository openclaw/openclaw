import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runNodePrepareSystemRun } from "./prepare-system-run.js";

describe("runNodePrepareSystemRun", () => {
  it("returns the canonical plan and allow-always coverage", async () => {
    const output = await runNodePrepareSystemRun(
      Readable.from([
        JSON.stringify({
          command: ["/bin/sh", "-lc", "/bin/echo ok"],
          rawCommand: "/bin/echo ok",
          agentId: "main",
          sessionKey: "session-1",
        }),
      ]),
    );

    expect(JSON.parse(output)).toMatchObject({
      plan: {
        argv: ["/bin/sh", "-lc", "/bin/echo ok"],
        agentId: "main",
        sessionKey: "session-1",
      },
      allowAlwaysCoverage: { complete: true },
    });
  });

  it("rejects blocked environment overrides", async () => {
    await expect(
      runNodePrepareSystemRun(
        Readable.from([
          JSON.stringify({
            command: ["/bin/sh", "-lc", "/bin/echo ok"],
            rawCommand: "/bin/echo ok",
            env: { PATH: "/tmp" },
          }),
        ]),
      ),
    ).rejects.toThrow("blocked override keys: PATH");
  });
});
