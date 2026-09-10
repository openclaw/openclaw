import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { listMemoryArtifactProvenance } from "../../../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../../../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-memory-auto-");
  });

  afterEach(async () => {
    await flushSessionMemoryWritesForTest();
    resetPluginStateStoreForTests();
  });

  const rolloverAt = new Date("2026-03-04T05:06:07.000Z");

  function makeConfig(storePath: string): OpenClawConfig {
    return {
      agents: { defaults: { workspace: tempDir } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
  }

  async function storeRolloverTranscript(params: {
    storePath: string;
    sessionId: string;
    sessionKey: string;
    marker: string;
  }): Promise<void> {
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      [
        {
          type: "message",
          id: `${params.sessionId}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember ${params.marker}`,
            __openclaw: { senderIsOwner: true },
          },
        },
        {
          type: "message",
          id: `${params.sessionId}-assistant`,
          parentId: `${params.sessionId}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ],
    );
  }

  function buildRolloverEvent(params: {
    cfg: OpenClawConfig;
    storePath: string;
    sessionId: string;
    sessionKey: string;
  }) {
    return {
      ...createInternalHookEvent("session", "auto-reset", params.sessionKey, {
        cfg: params.cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath: params.storePath,
        sessionEntry: { sessionId: params.sessionId },
        reason: "daily",
      }),
      timestamp: rolloverAt,
    };
  }

  async function runRollover(params: {
    storePath: string;
    sessionId: string;
    sessionKey: string;
    marker: string;
  }): Promise<void> {
    await storeRolloverTranscript(params);
    await handler(
      buildRolloverEvent({
        cfg: makeConfig(params.storePath),
        storePath: params.storePath,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      }),
    );
  }

  async function resolveCapturedBasename(memoryDir: string): Promise<string> {
    const files = await fs.readdir(memoryDir);
    return expectDefined(files[0], "files[0] test invariant").replace(/\.md$/u, "");
  }

  it.each(["daily", "idle"] as const)(
    "creates memory from the ended session on %s reset",
    async (reason) => {
      const sessionKey = "agent:main:main";
      const sessionId = `${reason}-session`;
      const storePath = path.join(tempDir, "sessions.json");
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember the ${reason} rollover`,
            __openclaw: { senderIsOwner: true },
          },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ]);
      const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId },
        reason,
      });

      const completed = handler(event);
      expect(completed).toBeInstanceOf(Promise);
      await completed;

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: ${JSON.stringify(`Remember the ${reason} rollover`)}`);
      expect(memoryContent).toContain(`assistant: ${JSON.stringify("Captured automatically")}`);
    },
  );

  it("keeps both rollovers when two sessions reset in the same minute", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    const sessions = [
      { sessionKey: "agent:main:chat-alpha", sessionId: "alpha-session", marker: "ALPHA-ONLY" },
      { sessionKey: "agent:main:chat-beta", sessionId: "beta-session", marker: "BETA-ONLY" },
    ];

    for (const session of sessions) {
      await replaceTranscriptEvents(
        {
          agentId: "main",
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          storePath,
        },
        [
          {
            type: "message",
            id: `${session.sessionId}-user`,
            parentId: null,
            message: {
              role: "user",
              content: `Remember ${session.marker}`,
              __openclaw: { senderIsOwner: true },
            },
          },
          {
            type: "message",
            id: `${session.sessionId}-assistant`,
            parentId: `${session.sessionId}-user`,
            message: { role: "assistant", content: "Captured automatically" },
          },
        ],
      );
    }

    const events = sessions.map((session) => ({
      ...createInternalHookEvent("session", "auto-reset", session.sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId: session.sessionId },
        reason: "daily",
      }),
      timestamp: rolloverAt,
    }));

    await Promise.all(events.map((event) => handler(event)));

    const memoryDir = path.join(tempDir, "memory");
    const files = (await fs.readdir(memoryDir)).sort();
    expect(files).toHaveLength(2);
    const contents = await Promise.all(
      files.map(async (file) => await fs.readFile(path.join(memoryDir, file), "utf8")),
    );
    for (const session of sessions) {
      expect(
        contents.filter((content) => content.includes(`Remember ${session.marker}`)),
      ).toHaveLength(1);
    }
  });

  it("keeps the capture when every numbered filename is already occupied", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    await runRollover({
      storePath,
      sessionId: "first-session",
      sessionKey: "agent:main:chat-first",
      marker: "FIRST-ONLY",
    });

    const memoryDir = path.join(tempDir, "memory");
    const basename = await resolveCapturedBasename(memoryDir);
    for (let suffix = 2; suffix <= 64; suffix += 1) {
      await fs.writeFile(path.join(memoryDir, `${basename}-${suffix}.md`), "occupied", "utf8");
    }

    await runRollover({
      storePath,
      sessionId: "late-session",
      sessionKey: "agent:main:chat-late",
      marker: "LATE-ONLY",
    });

    const files = await fs.readdir(memoryDir);
    expect(files).toHaveLength(65);
    const contents = await Promise.all(
      files.map(async (file) => await fs.readFile(path.join(memoryDir, file), "utf8")),
    );
    expect(contents.filter((content) => content.includes("Remember LATE-ONLY"))).toHaveLength(1);
  });

  it("skips occupied candidates that are not regular files", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    await runRollover({
      storePath,
      sessionId: "first-session",
      sessionKey: "agent:main:chat-first",
      marker: "FIRST-ONLY",
    });

    const memoryDir = path.join(tempDir, "memory");
    const basename = await resolveCapturedBasename(memoryDir);
    await fs.mkdir(path.join(memoryDir, `${basename}-2.md`));
    await fs.link(path.join(memoryDir, `${basename}.md`), path.join(memoryDir, `${basename}-3.md`));

    await runRollover({
      storePath,
      sessionId: "late-session",
      sessionKey: "agent:main:chat-late",
      marker: "LATE-ONLY",
    });

    const captured = await fs.readFile(path.join(memoryDir, `${basename}-4.md`), "utf8");
    expect(captured).toContain("Remember LATE-ONLY");
  });

  it("preserves provenance of an occupied artifact when concurrent rollovers lose the claim", async () => {
    await withStateDirEnv("openclaw-session-memory-provenance-", async () => {
      const storePath = path.join(tempDir, "sessions.json");
      await runRollover({
        storePath,
        sessionId: "origin-session",
        sessionKey: "agent:main:chat-origin",
        marker: "ORIGIN-ONLY",
      });

      const memoryDir = path.join(tempDir, "memory");
      const basename = await resolveCapturedBasename(memoryDir);
      const occupied = `${basename}.md`;
      const readProvenance = async () => {
        const entries = await listMemoryArtifactProvenance({ workspaceDir: tempDir });
        return entries.find((entry) => entry.relativePath.endsWith(occupied))?.provenance;
      };
      const before = expectDefined(await readProvenance(), "origin provenance test invariant");
      expect(before.sessionId).toBe("origin-session");

      const losers = [
        { sessionId: "alpha-session", sessionKey: "agent:main:chat-alpha", marker: "ALPHA-ONLY" },
        { sessionId: "beta-session", sessionKey: "agent:main:chat-beta", marker: "BETA-ONLY" },
      ];
      for (const loser of losers) {
        await storeRolloverTranscript({ storePath, ...loser });
      }
      await Promise.all(
        losers.map(async (loser) =>
          handler(
            buildRolloverEvent({
              cfg: makeConfig(storePath),
              storePath,
              sessionId: loser.sessionId,
              sessionKey: loser.sessionKey,
            }),
          ),
        ),
      );

      expect(await readProvenance()).toEqual(before);
      expect(await fs.readFile(path.join(memoryDir, occupied), "utf8")).toContain(
        "Remember ORIGIN-ONLY",
      );
      expect(await fs.readdir(memoryDir)).toHaveLength(3);
    });
  });
});
