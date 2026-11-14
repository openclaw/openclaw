import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createInternalHookEvent } from "../../internal-hooks.js";

const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<typeof import("../../../agents/embedded-agent.js").runEmbeddedAgent>(),
);

vi.mock("../../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/embedded-agent.js")>()),
  runEmbeddedAgent,
}));

import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  runEmbeddedAgent.mockReset();
  await flushSessionMemoryWritesForTest();
});

describe("session-memory gateway admission", () => {
  it("keeps detached manual-reset slug generation admitted after the request returns", async () => {
    const tempDir = tempDirs.make("openclaw-session-memory-admission-");
    const sessionId = "manual-reset-session";
    const sessionKey = "agent:main:main";
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      hooks: { internal: { entries: { "session-memory": { enabled: true, llmSlug: true } } } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey, storePath },
      ["user", "assistant"].map((role, index) => ({
        type: "message",
        id: String(index),
        parentId: index ? "0" : null,
        message: {
          role,
          content: "Keep a descriptive memory filename",
          __openclaw: { senderIsOwner: true },
        },
      })),
    );
    const event = createInternalHookEvent("command", "reset", sessionKey, {
      agentId: "main",
      cfg,
      previousSessionEntry: { sessionId },
      workspaceDir: tempDir,
    });
    let subordinateClosedInsideSlug: boolean | undefined;
    runEmbeddedAgent.mockImplementationOnce(async () => {
      subordinateClosedInsideSlug = isGatewaySubordinateWorkAdmissionClosed();
      return {
        payloads: subordinateClosedInsideSlug ? [] : [{ text: "admitted-slug" }],
        meta: { durationMs: 0 },
      };
    });

    await withEnvAsync(
      {
        NODE_ENV: "production",
        OPENCLAW_TEST_FAST: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      async () => {
        const admission = tryBeginGatewayRootWorkAdmission();
        expect(admission).not.toBeNull();
        await admission?.run(async () => {
          void handler(event);
          admission.release();
        });
        await flushSessionMemoryWritesForTest();

        await expect(fs.readdir(path.join(tempDir, "memory"))).resolves.toEqual([
          expect.stringMatching(/-admitted-slug\.md$/),
        ]);
      },
    );

    expect(subordinateClosedInsideSlug).toBe(false);
  });
});
