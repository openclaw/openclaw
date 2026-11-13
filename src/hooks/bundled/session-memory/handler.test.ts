import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { runEmbeddedAgent } from "../../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createInternalHookEvent as createHookEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
} from "../../internal-hooks.js";
import { captureSessionMemoryTranscript } from "./capture.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

// Avoid calling the embedded OpenClaw agent (global command lane); keep this unit test deterministic.
vi.mock("../../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn<typeof runEmbeddedAgent>().mockResolvedValue({
    payloads: [{ text: "simple-math" }],
    meta: { durationMs: 0 },
  }),
}));

const warn = vi.hoisted(() => vi.fn());
const recordProvenance = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (...args: Parameters<typeof original.createSubsystemLogger>) =>
      Object.assign(original.createSubsystemLogger(...args), { warn }),
  };
});

// mock-isolation: Observe provenance ordering and failures without writing the real provenance store.
vi.mock("../../../memory/memory-artifact-provenance.js", () => ({
  normalizeMemoryArtifactRelativePath: (relativePath: string) => relativePath,
  recordMemoryArtifactWriteProvenance: recordProvenance,
  clearMemoryArtifactProvenance: vi.fn(),
}));

vi.mock("./capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture.js")>();
  return {
    ...actual,
    captureSessionMemoryTranscript: vi.fn(actual.captureSessionMemoryTranscript),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const createCaseWorkspace = () => tempDirs.make("openclaw-session-memory-");

type MessageTrust = { senderIsOwner?: boolean; turnTainted?: boolean };
function message(role: string, content: string, __openclaw?: MessageTrust) {
  return { type: "message", message: { role, content, __openclaw } };
}

const readMemory = (dir: string, file: string) =>
  fs.readFile(path.join(dir, "memory", file), "utf-8");

async function runNew(params: {
  tempDir?: string;
  sessionId?: string;
  events?: Array<Record<string, unknown>>;
  cfg?: OpenClawConfig;
  userTimezone?: string;
  workspaceDirOverride?: string;
  timestamp?: Date;
}) {
  const tempDir = params.tempDir ?? createCaseWorkspace();
  const sessionId = params.sessionId ?? "test-123";
  const baseConfig: OpenClawConfig = params.cfg ?? {
    agents: { defaults: { workspace: tempDir, userTimezone: params.userTimezone } },
  };
  const sessionKey = "agent:main:main";
  const storePath = path.join(tempDir, "sessions.json");
  if (params.events) {
    const events = params.events.map((event, index) => ({
      ...event,
      id: `fixture-${index + 1}`,
      parentId: index === 0 ? null : `fixture-${index}`,
    }));
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, events);
  }
  const event = createHookEvent("command", "new", sessionKey, {
    agentId: "main",
    cfg: { ...baseConfig, session: { store: storePath } } satisfies OpenClawConfig,
    previousSessionEntry: { sessionId },
    ...(params.workspaceDirOverride ? { workspaceDir: params.workspaceDirOverride } : {}),
  });
  if (params.timestamp) {
    event.timestamp = params.timestamp;
  }
  await handler(event);
  await flushSessionMemoryWritesForTest();
  const files = await fs.readdir(path.join(tempDir, "memory"));
  const memoryContent = files[0] ? await readMemory(tempDir, files[0]) : "";
  return { tempDir, files, memoryContent };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("session-memory hook", () => {
  it.each([
    { type: "command", action: "new", sessionKey: "agent:main:dashboard:incognito-new" },
    { type: "session", action: "auto-reset", sessionKey: "agent:main:dashboard:incognito-idle" },
    { type: "command", action: "reset", sessionKey: "agent:main:private", incognito: true },
  ] as const)("does not capture Incognito $type:$action memory ($sessionKey)", async (testCase) => {
    const workspaceDir = createCaseWorkspace();
    const event = createHookEvent(testCase.type, testCase.action, testCase.sessionKey, {
      agentId: "main",
      workspaceDir,
      sessionEntry: { sessionId: "private-session", incognito: "incognito" in testCase },
      previousSessionMemory: {
        status: "available",
        content: "SYNTHETIC_INCOGNITO_MEMORY_SENTINEL",
        originClass: "agent",
      },
      reason: "idle",
    });
    const eventKey = `${testCase.type}:${testCase.action}`;
    registerInternalHook(eventKey, handler);
    try {
      await triggerInternalHook(event);
      await flushSessionMemoryWritesForTest();
      await expectPathMissing(path.join(workspaceDir, "memory"));
    } finally {
      unregisterInternalHook(eventKey, handler);
    }
  });

  it("skips commands other than new", async () => {
    const tempDir = createCaseWorkspace();
    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });
    await handler(event);
    await expectPathMissing(path.join(tempDir, "memory"));
  });

  it.each([
    ["owner-only transcript", true, false, "agent"],
    ["non-owner transcript", false, false, "untrusted"],
    ["tainted assistant response", true, true, "untrusted"],
  ] as const)("records %s provenance before writing", async (_, owner, tainted, origin) => {
    recordProvenance.mockClear();
    recordProvenance.mockImplementationOnce(async (write) => {
      await expectPathMissing(path.join(write.workspaceDir, write.relativePath));
    });
    const events = [
      message("user", "Retain this request", { senderIsOwner: owner }),
      message("assistant", "Retained response", tainted ? { turnTainted: true } : undefined),
    ];
    const tempDir = createCaseWorkspace();
    const { files, memoryContent } = await runNew({
      tempDir,
      events,
      cfg: {
        agents: { defaults: { workspace: tempDir } },
        plugins: { slots: { memory: "none" } },
      },
    });
    expect(files).toHaveLength(1);
    expect(recordProvenance).toHaveBeenCalledOnce();
    expect(recordProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: tempDir,
        relativePath: `memory/${files[0]}`,
        contentBefore: "",
        contentAfter: memoryContent,
        originClass: origin,
      }),
    );
  });

  it("does not commit session memory when provenance recording fails", async () => {
    recordProvenance.mockRejectedValueOnce(new Error("provenance unavailable"));
    const events = [message("user", "Do not persist without provenance", { senderIsOwner: false })];
    const { files } = await runNew({ events });
    expect(files).toEqual([]);
  });

  it("records and warns when transcript loading fails after reset capture", async () => {
    const sessionKey = "agent:main:main";
    const reason = "projection unavailable";
    vi.mocked(captureSessionMemoryTranscript).mockResolvedValueOnce({
      status: "unavailable",
      reason,
    });
    warn.mockClear();
    const { memoryContent } = await runNew({ sessionId: "unavailable-transcript" });
    expect(warn).toHaveBeenCalledWith("Session transcript unavailable for memory capture", {
      sessionKey,
      error: reason,
    });
    expect(memoryContent).toContain(
      `## Conversation Summary\n\n> Transcript content was unavailable: ${JSON.stringify(reason)}`,
    );
  });

  it("fills the configured memory window past ineligible tail messages", async () => {
    const tempDir = createCaseWorkspace();
    const { memoryContent } = await runNew({
      tempDir,
      sessionId: "sqlite-filtered-tail",
      events: [
        message("user", "User context"),
        message("assistant", "Assistant context"),
        ...Array.from({ length: 20 }, (_, index) =>
          message("toolResult", `ignored tool result ${index}`),
        ),
        message("assistant", "NO_REPLY"),
      ],
      cfg: {
        agents: { defaults: { workspace: tempDir } },
        hooks: {
          internal: {
            entries: { "session-memory": { enabled: true, messages: 2 } },
          },
        },
      },
    });
    expect(memoryContent).toContain('user: "User context"');
    expect(memoryContent).toContain('assistant: "Assistant context"');
    expect(memoryContent).not.toContain("ignored tool result");
    expect(memoryContent).not.toContain("NO_REPLY");
  });

  it("does not call the model provider for a filename slug by default", async () => {
    const events = [message("user", "Hello there"), message("assistant", "Hi! How can I help?")];
    const generateSlug = vi.mocked(runEmbeddedAgent);
    generateSlug.mockClear();
    await withEnvAsync(
      {
        NODE_ENV: "production",
        OPENCLAW_TEST_FAST: undefined,
        VITEST: undefined,
      },
      async () => {
        const { files } = await runNew({ events });
        expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
      },
    );
    expect(generateSlug).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "04", "2025-12-31", "2330", "23:30:15"],
    ["Asia/Jakarta", "18", "2026-01-02", "0130", "01:30:15"],
  ] as const)(
    "uses timezone %s (host fallback when unset) for filename and header",
    async (userTimezone, hour, date, slug, time) => {
      await withEnvAsync({ TZ: "America/New_York" }, async () => {
        const { files, memoryContent } = await runNew({
          userTimezone,
          timestamp: new Date(`2026-01-01T${hour}:30:15.000Z`),
        });
        expect(files).toEqual([`${date}-${slug}.md`]);
        expect(memoryContent).toMatch(
          new RegExp(`^# Session: ${date} ${time} ${userTimezone ?? "America/New_York"}`),
        );
        expect(memoryContent).not.toContain("# Session: 2026-01-01 04:30:15 UTC");
      });
    },
  );

  it("keeps same-minute fallback timestamp captures by adding a filename suffix", async () => {
    await withEnvAsync({ TZ: "UTC" }, async () => {
      const tempDir = createCaseWorkspace();
      const timestamp = new Date("2026-01-01T04:30:15.000Z");
      await runNew({ tempDir, timestamp, sessionId: "first-session" });
      const { files } = await runNew({ tempDir, timestamp, sessionId: "second-session" });
      expect(files.toSorted()).toEqual(["2026-01-01-0430-2.md", "2026-01-01-0430.md"]);
      await expect(readMemory(tempDir, "2026-01-01-0430.md")).resolves.toContain(
        "- **Session ID**: first-session",
      );
      await expect(readMemory(tempDir, "2026-01-01-0430-2.md")).resolves.toContain(
        "- **Session ID**: second-session",
      );
    });
  });

  it("prefers workspaceDir from hook context when sessionKey points at main", async () => {
    const mainWorkspace = createCaseWorkspace();
    const naviWorkspace = createCaseWorkspace();
    const { files, memoryContent } = await runNew({
      tempDir: naviWorkspace,
      cfg: {
        agents: {
          defaults: { workspace: mainWorkspace },
          entries: { navi: { workspace: naviWorkspace } },
        },
      } satisfies OpenClawConfig,
      workspaceDirOverride: naviWorkspace,
      sessionId: "navi-session",
      events: [message("user", "Navi request"), message("assistant", "Navi response")],
    });
    expect(files.length).toBe(1);
    expect(memoryContent).toContain('user: "Navi request"');
    expect(memoryContent).toContain('assistant: "Navi response"');
    expect(memoryContent).toContain("- **Session Key**: agent:navi:main");
    await expectPathMissing(path.join(mainWorkspace, "memory"));
  });
});
