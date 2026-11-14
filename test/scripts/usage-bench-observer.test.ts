import { fork } from "node:child_process";
import { on, once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { withinTest } from "../helpers/promise.js";

it("observes a new worker's first Usage task and preserves native message transfers", async ({
  signal,
}) => {
  const child = fork(
    fileURLToPath(new URL("./usage-bench-observer.fixture.mjs", import.meta.url)),
    {
      execPath: resolveTestNodeExecPath(),
      execArgv: [
        "--import",
        fileURLToPath(new URL("../../scripts/lib/usage-bench-observer.mjs", import.meta.url)),
      ],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(child, "exit");
  let transport: unknown;
  let dispatches: unknown;
  try {
    for await (const [message] of on(child, "message", { signal, close: ["exit"] })) {
      if (message.channel === "observer-test") {
        transport = message;
        child.send({ channel: "usage-volume-fixture", action: "snapshot" });
      } else if (message.channel === "usage-volume-fixture") {
        dispatches = message.dispatches;
        break;
      }
    }
    expect(transport).toEqual({
      channel: "observer-test",
      replies: [1, 2, 3],
      detachedBytes: [0, 0],
    });
    expect(dispatches).toEqual([
      { kind: "prepare", rows: 2, contextRows: 1, packedBytes: 24 },
      { kind: "cohorts", rows: 1, contextRows: 0, packedBytes: 0 },
    ]);
    child.disconnect();
    await expect(withinTest(exited, signal)).resolves.toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
  }
});
