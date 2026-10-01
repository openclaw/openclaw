import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

async function createArchiveSession(dir: string, name: string, sessionId = `session-${name}`) {
  const storePath = path.join(dir, "sessions.json");
  const sessionKey = `agent:main:${name}`;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId, updatedAt: 1 },
  );
  return {
    storePath,
    sessionKey,
    sessionId,
    createTool: (callGateway: AgentToolGatewayRequestCaller) =>
      createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config: { session: { store: storePath } },
        callGateway,
      }),
    beginAdmission: (id = sessionId) =>
      beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, id],
        assertAllowed: () => {},
      }),
    archiveRequest: {
      method: "sessions.patch",
      params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
    },
  };
}

describe("sessions tool self-archive", () => {
  it("returns success before a detached dynamic-tool self-archive commits", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-detached-archive-" }, async (dir) => {
      const { storePath, sessionKey, sessionId, createTool, beginAdmission, archiveRequest } =
        await createArchiveSession(dir, "detached-self-archive");
      const runAbort = new AbortController();
      const callGateway = vi.fn(async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          { sessionId, updatedAt: 2, archivedAt: Date.now() },
        );
        runAbort.abort(new Error("archive stopped the active turn"));
        return { ok: true };
      });
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();

      try {
        const projected = await Promise.race([
          tool.execute("archive-current", { action: "patch", archived: true }).then((result) => ({
            success: true as const,
            result,
          })),
          new Promise<{ success: false }>((resolve) => {
            runAbort.signal.addEventListener("abort", () => resolve({ success: false }), {
              once: true,
            });
          }),
        ]);

        expect(projected.success).toBe(true);
        if (projected.success) {
          expect(projected.result.details).toMatchObject({
            status: "scheduled",
            sessionKey,
          });
        }
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
          "archivedAt",
        );
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toHaveProperty(
          "archivedAt",
        );
      });
    });
  });

  it("defers self-archiving until the current agent turn has completed", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-self-archive-" }, async (dir) => {
      const { storePath, sessionKey, createTool, beginAdmission, archiveRequest } =
        await createArchiveSession(dir, "self-archive");
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();

      try {
        const result = await admission.run(async () => {
          const pending = await tool.execute("archive-current", {
            action: "patch",
            archived: true,
          });
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
            "archivedAt",
          );
          return pending;
        });

        expect(result.details).toMatchObject({
          status: "scheduled",
          sessionKey,
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
      });
    });
  });

  it("applies other self-patch settings before the deferred archive", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-patch-" }, async (dir) => {
      const { sessionKey, sessionId, createTool, beginAdmission } = await createArchiveSession(
        dir,
        "archive-patch",
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();

      try {
        await admission.run(async () => {
          const result = await tool.execute("archive-and-label", {
            action: "patch",
            label: "Finished research",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
          expect(callGateway).toHaveBeenCalledExactlyOnceWith({
            method: "sessions.patch",
            params: {
              key: sessionKey,
              label: "Finished research",
              expectedSessionId: sessionId,
            },
          });
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway.mock.calls).toEqual([
          [
            {
              method: "sessions.patch",
              params: { key: sessionKey, label: "Finished research", expectedSessionId: sessionId },
            },
          ],
          [
            {
              method: "sessions.patch",
              params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
            },
          ],
        ]);
      });
    });
  });

  it("does not apply a deferred archive to a replacement session", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-replacement-" }, async (dir) => {
      const { storePath, sessionKey, createTool, beginAdmission } = await createArchiveSession(
        dir,
        "archive-replacement",
        "session-before-reset",
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();
      let replacementAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;

      try {
        await admission.run(async () => {
          await tool.execute("archive-before-reset", { action: "patch", archived: true });
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey, storePath },
            { sessionId: "session-after-reset", updatedAt: 2 },
          );
          replacementAdmission = await beginAdmission("session-after-reset");
        });
      } finally {
        admission.release();
      }

      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
          sessionId: "session-after-reset",
        });
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
          "archivedAt",
        );
      } finally {
        replacementAdmission?.release();
      }
    });
  });

  it("waits for a competing turn before applying a scheduled archive", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-competing-" }, async (dir) => {
      const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
        dir,
        "archive-competing",
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createTool(callGateway as never);
      const currentAdmission = await beginAdmission();
      const competingAdmission = await beginAdmission();

      try {
        await currentAdmission.run(async () => {
          const result = await tool.execute("archive-after-competition", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
        currentAdmission.release();

        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(callGateway).not.toHaveBeenCalled();
      } finally {
        currentAdmission.release();
        competingAdmission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
      });
    });
  });

  it("retries a scheduled archive when a turn races the gateway mutation", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-retry-" }, async (dir) => {
      const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
        dir,
        "archive-retry",
      );
      let competingAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      const callGateway = vi.fn(async () => {
        if (!competingAdmission) {
          competingAdmission = await beginAdmission();
          throw Object.assign(new Error("Session did not finish stopping."), { retryable: true });
        }
        return { ok: true };
      });
      const tool = createTool(callGateway as never);
      const currentAdmission = await beginAdmission();

      try {
        await currentAdmission.run(async () => {
          const result = await tool.execute("archive-after-race", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
        currentAdmission.release();

        await vi.waitFor(() => {
          expect(callGateway).toHaveBeenCalledTimes(1);
          expect(competingAdmission).toBeDefined();
        });
      } finally {
        currentAdmission.release();
        competingAdmission?.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(2);
        expect(callGateway).toHaveBeenLastCalledWith(archiveRequest);
      });
    });
  });

  it("retries when a competing turn releases before its archive rejection settles", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-release-race-" }, async (dir) => {
      const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
        dir,
        "archive-release-race",
      );
      let competingTurnFinished = false;
      const callGateway = vi.fn(async () => {
        if (!competingTurnFinished) {
          const competingAdmission = await beginAdmission();
          competingAdmission.release();
          competingTurnFinished = true;
          throw Object.assign(new Error("Session did not finish stopping."), { retryable: true });
        }
        return { ok: true };
      });
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();

      try {
        await admission.run(async () => {
          const result = await tool.execute("archive-after-release-race", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(2);
        expect(callGateway).toHaveBeenLastCalledWith(archiveRequest);
      });
    });
  });

  it("retries a scheduled archive after a transient gateway failure", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-transport-" }, async (dir) => {
      const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
        dir,
        "archive-transport",
      );
      const callGateway = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
        .mockResolvedValue({ ok: true });
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();

      try {
        await admission.run(async () => {
          const result = await tool.execute("archive-after-disconnect", {
            action: "patch",
            archived: true,
          });
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(2);
        expect(callGateway).toHaveBeenLastCalledWith(archiveRequest);
      });
    });
  });

  it("keeps retrying a projected active run without abandoning its archive", async () => {
    vi.useFakeTimers();
    try {
      await withTestDir({ prefix: "openclaw-sessions-tool-archive-projected-" }, async (dir) => {
        const { sessionKey, createTool, beginAdmission, archiveRequest } =
          await createArchiveSession(dir, "archive-projected");
        let attempts = 0;
        const callGateway = vi.fn(async () => {
          attempts += 1;
          if (attempts <= 10) {
            throw Object.assign(new Error("Session did not finish stopping."), {
              retryable: true,
            });
          }
          return { ok: true };
        });
        const tool = createTool(callGateway as never);
        const admission = await beginAdmission();

        try {
          await admission.run(async () => {
            const result = await tool.execute("archive-after-projected-run", {
              action: "patch",
              archived: true,
            });
            expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
          });
        } finally {
          admission.release();
        }

        await vi.advanceTimersByTimeAsync(30_000);
        expect(callGateway).toHaveBeenCalledTimes(11);
        expect(callGateway).toHaveBeenLastCalledWith(archiveRequest);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps main-session archive validation on the gateway", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-main-" }, async (dir) => {
      const { createTool, beginAdmission, archiveRequest } = await createArchiveSession(
        dir,
        "main",
        "session-main-archive",
      );
      const callGateway = vi.fn(async () => ({ ok: true }));
      const tool = createTool(callGateway as never);
      const admission = await beginAdmission();

      try {
        await admission.run(async () => {
          await tool.execute("archive-main", { action: "patch", archived: true });
          expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
        });
      } finally {
        admission.release();
      }
    });
  });
});
