import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { configureHeapRigTurns } from "../../scripts/lib/gateway-heap-rig-turns.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["response preparation", "session creation"])(
  "does not launch a turn when admission closes during %s",
  async (closeAt) => {
    const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
    let admissionOpen = true;
    const rpc = vi.fn(async (method: string, params: { key?: string }) => {
      if (closeAt === "session creation" && method === "sessions.create") {
        admissionOpen = false;
        return { ok: true, key: params.key, sessionId: "synthetic-session" };
      }
      throw new Error("Expired admission launched a Gateway request");
    });
    const turn = driver.runTurn(rpc, 0, {
      agentId: "main",
      canStart: () => admissionOpen,
    });
    if (closeAt === "response preparation") {
      admissionOpen = false;
    }

    await expect(turn).resolves.toBeNull();
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(
      closeAt === "session creation" ? ["sessions.create"] : [],
    );
  },
);

it.each(["code", "subagent"])("emits executable %s code through chat.send", async (kind) => {
  const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
  const stopBeforeDispatch = new Error("fixture stops before Gateway execution");
  const rpc = vi.fn(async (method: string, params: { key?: string }) => {
    if (method === "sessions.create") {
      return { ok: true, key: params.key, sessionId: "synthetic-session" };
    }
    throw stopBeforeDispatch;
  });

  await expect(
    driver.runTurn(rpc, 0, { kind, agentId: "main", canStart: () => true }),
  ).rejects.toBe(stopBeforeDispatch);

  const control = JSON.parse(await readFile(driver.responseControlPath, "utf8"));
  const item = control.responses[0].events.find(
    (event: { type: string }) => event.type === "response.output_item.done",
  ).item;
  const { code } = JSON.parse(item.arguments);
  expect(() => new Script(`(async () => { ${code} })`)).not.toThrow();
  expect(rpc).toHaveBeenLastCalledWith(
    "chat.send",
    expect.objectContaining({ sessionKey: "agent:main:heap-rig-pool-0", agentId: "main" }),
    120_000,
  );
});

it("refuses pool replacement when the existing session cannot be deleted", async () => {
  const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
  const rejectedSend = new Error("Gateway rejected the send before admission");
  const rpc = vi.fn(async (method: string, params: { key?: string }) => {
    if (method === "sessions.create") {
      return { ok: true, key: params.key, sessionId: "synthetic-session" };
    }
    if (method === "sessions.patch") {
      return { ok: true };
    }
    if (method === "sessions.delete") {
      return { ok: true, key: params.key, deleted: false };
    }
    throw rejectedSend;
  });
  await expect(driver.runTurn(rpc, 0, { kind: "code", agentId: "main" })).rejects.toBe(
    rejectedSend,
  );
  rpc.mockClear();

  await expect(driver.runTurn(rpc, 32, { agentId: "main" })).rejects.toThrow(
    "Synthetic session cleanup failed",
  );

  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "sessions.delete"]);
  for (const [, params] of rpc.mock.calls) {
    expect(params).toMatchObject({
      key: "agent:main:heap-rig-pool-0",
      expectedSessionId: "synthetic-session",
    });
  }
  expect(driver.counts.created).toBe(1);
  expect(driver.counts.deleted).toBe(0);
});
