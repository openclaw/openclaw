// Covers that the agent RPC entrypoint refuses new runs while the operator
// killswitch is engaged, ahead of any session/agent resolution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { engageKillswitchSync, releaseKillswitchSync } from "../../infra/killswitch.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { agentHandlers } from "./agent.js";
import type { RespondFn } from "./types.js";

const tempDirs: string[] = [];

describe("agent RPC killswitch guard", () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-killswitch-"));
    tempDirs.push(dir);
    process.env.OPENCLAW_STATE_DIR = dir;
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    delete process.env.OPENCLAW_STATE_DIR;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("refuses a new run while engaged, without touching session resolution", async () => {
    engageKillswitchSync({ reason: "test pause", source: "cli" });
    const respond = vi.fn() as unknown as RespondFn;

    await agentHandlers.agent({
      req: { id: "req-1" } as never,
      params: {
        sessionKey: "agent:main:global",
        message: "hi",
        idempotencyKey: "run-1",
      },
      respond,
      context: {
        dedupe: new Map(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = (respond as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: ErrorCodes.UNAVAILABLE,
      message: expect.stringContaining("test pause"),
    });
  });

  it("proceeds past the guard once released", async () => {
    engageKillswitchSync({ reason: "test pause", source: "cli" });
    releaseKillswitchSync({ source: "cli" });
    const respond = vi.fn() as unknown as RespondFn;

    await agentHandlers.agent({
      req: { id: "req-2" } as never,
      params: {
        sessionKey: "agent:main:global",
        message: "hi",
        idempotencyKey: "run-2",
        cwd: "not-absolute",
      },
      respond,
      context: {
        dedupe: new Map(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    // Past the killswitch guard, the next check (cwd must be absolute) fires
    // instead — proving the guard itself is not what's blocking this call.
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "cwd must be absolute" }),
    );
  });
});
