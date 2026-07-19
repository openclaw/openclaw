import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("createReplyRestartRecoveryClaimController", () => {
  it("retargets durable user-turn admission to the prepared reply session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-admission-"));
    tempDirs.push(root);
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "plugin-binding:codex:target";
    const sessionId = "bound-session-id";
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);

    let persistedTarget: UserTurnTranscriptTarget | undefined;
    const persistApproved = vi.fn<UserTurnTranscriptRecorder["persistApproved"]>(async (params) => {
      persistedTarget =
        typeof params?.target === "function" ? await params.target() : params?.target;
      return {
        appended: true,
        message: { role: "user", content: "hello", timestamp: Date.now() },
        messageId: "user-turn-1",
        sessionEntry: entry,
        sessionFile: "sqlite:bound-session-id",
      };
    });
    const recorder = {
      hasPersisted: () => false,
      persistApproved,
    } as UserTurnTranscriptRecorder;
    const controller = createReplyRestartRecoveryClaimController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      resolveUserTurnTarget: (target) => ({
        ...target,
        sessionEntry: target.entry,
        agentId: "main",
      }),
      sessionKey,
      setEntry: () => {},
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    expect(persistApproved).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionId: sessionId }),
    );
    expect(persistedTarget).toMatchObject({
      sessionId,
      sessionKey,
      storePath,
      agentId: "main",
    });
  });
});
