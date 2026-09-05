import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadExactSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const mocks = vi.hoisted(() => ({
  deleteCronSessionViaGateway: vi.fn(),
}));

vi.mock("./isolated-agent/session-cleanup.js", () => ({
  deleteCronSessionViaGateway: mocks.deleteCronSessionViaGateway,
}));

import { removeCronJobBaseSession } from "./session-reaper.js";

const { makeStorePath } = setupCronServiceSuite({
  prefix: "cron-reaper-worker-placement-",
});

describe("removeCronJobBaseSession worker placement", () => {
  beforeEach(() => {
    mocks.deleteCronSessionViaGateway.mockReset();
  });

  it("routes a session through the gateway even before any placement is observed", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:unplaced-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "unplaced-session", updatedAt: 123 },
    );
    const existing = loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })!.entry;
    mocks.deleteCronSessionViaGateway.mockResolvedValue(true);

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "unplaced-job",
        sessionStorePath,
      }),
    ).resolves.toBe(true);

    expect(mocks.deleteCronSessionViaGateway).toHaveBeenCalledWith({
      agentSessionKey: sessionKey,
      sessionId: "unplaced-session",
      lifecycleRevision: existing.lifecycleRevision,
      sessionUpdatedAt: existing.updatedAt,
    });
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeDefined();
  });

  it("never falls back to direct removal when the gateway rejects a raced placement", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:raced-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "raced-session", updatedAt: 234 },
    );
    let placement: { sessionId: string } | undefined;
    expect(placement).toBeUndefined();
    mocks.deleteCronSessionViaGateway.mockImplementation(async (params: { sessionId: string }) => {
      // This callback runs only after cron loaded the session identity. Simulate a
      // placement appearing before the Gateway lifecycle reaches its commit fence.
      placement = { sessionId: params.sessionId };
      return false;
    });

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "raced-job",
        sessionStorePath,
      }),
    ).resolves.toBe(false);

    expect(mocks.deleteCronSessionViaGateway).toHaveBeenCalledTimes(1);
    expect(placement).toEqual({ sessionId: "raced-session" });
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "raced-session" },
    });
  });

  it("keeps direct lifecycle removal only for sessions without a usable session id", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:local-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "", updatedAt: 456 },
    );

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "local-job",
        sessionStorePath,
      }),
    ).resolves.toBe(true);

    expect(mocks.deleteCronSessionViaGateway).not.toHaveBeenCalled();
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
  });
});
