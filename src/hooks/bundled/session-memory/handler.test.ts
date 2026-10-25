import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createInternalHookEvent as createHookEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
} from "../../internal-hooks.js";
import { captureSessionMemoryTranscript } from "./capture.js";

// Avoid calling the embedded OpenClaw agent (global command lane); keep this unit test deterministic.
vi.mock("../../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn<typeof runEmbeddedAgent>().mockResolvedValue({
    payloads: [{ text: "simple-math" }],
    meta: { durationMs: 0 },
  }),
}));

const loggerMocks = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const memoryProvenanceMocks = vi.hoisted(() => ({
  recordMemoryArtifactWriteProvenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (...args: Parameters<typeof original.createSubsystemLogger>) =>
      Object.assign(original.createSubsystemLogger(...args), loggerMocks),
  };
});

vi.mock("../../../memory/memory-artifact-provenance.js", () => ({
  normalizeMemoryArtifactRelativePath: (relativePath: string) => relativePath,
  recordMemoryArtifactWriteProvenance: memoryProvenanceMocks.recordMemoryArtifactWriteProvenance,
  clearMemoryArtifactProvenance: vi.fn(),
}));

vi.mock("./capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture.js")>();
  return {
    ...actual,
    captureSessionMemoryTranscript: vi.fn(actual.captureSessionMemoryTranscript),
  };
});

let handler: typeof import("./handler.js").default;
let flushSessionMemoryWritesForTest: typeof import("./handler.js").flushSessionMemoryWritesForTest;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler, flushSessionMemoryWritesForTest } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
});

function createSessionMessages(
  entries: Array<{
    role: string;
    content: string;
    __openclaw?: { senderIsOwner?: boolean; turnTainted?: boolean };
  }>,
) {
  return entries.map((message) => ({ type: "message", message }));
}

function sessionMemoryRecord(role: "user" | "assistant", text: string): string {
  return `${role}: ${JSON.stringify(text)}`;
}

async function runNew(params: {
  tempDir?: string;
  sessionId?: string;
  events?: Array<Record<string, unknown>>;
  cfg?: OpenClawConfig;
  sessionKey?: string;
  workspaceDirOverride?: string;
  timestamp?: Date;
}) {
  const tempDir = params.tempDir ?? (await createCaseWorkspace("workspace"));
  const sessionId = params.sessionId ?? "test-123";
  const baseConfig: OpenClawConfig = params.cfg ?? { agents: { defaults: { workspace: tempDir } } };
  const sessionKey = params.sessionKey ?? "agent:main:main";
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    throw new Error("session-memory fixture requires an agent owner");
  }
  const storePath = baseConfig.session?.store ?? path.join(tempDir, "sessions.json");
  if (params.events) {
    const events = params.events.map((event, index) => ({
      ...event,
      id: `fixture-${index + 1}`,
      parentId: index === 0 ? null : `fixture-${index}`,
    }));
    await replaceTranscriptEvents({ agentId, sessionId, sessionKey, storePath }, events);
  }
  const cfg = {
    ...baseConfig,
    session: { ...baseConfig.session, store: storePath },
  } satisfies OpenClawConfig;
  const event = createHookEvent("command", "new", sessionKey, {
    agentId,
    cfg,
    previousSessionEntry: { sessionId },
    ...(params.workspaceDirOverride ? { workspaceDir: params.workspaceDirOverride } : {}),
  });
  if (params.timestamp) {
    event.timestamp = params.timestamp;
  }
  await handler(event);
  await flushSessionMemoryWritesForTest();
  const memoryDir = path.join(tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const memoryContent =
    files.length > 0
      ? await fs.readFile(
          path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
          "utf-8",
        )
      : "";
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
    const workspaceDir = await createCaseWorkspace("incognito");
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
    const tempDir = await createCaseWorkspace("workspace");
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
  ] as const)(
    "records %s provenance before committing the file",
    async (_, userOwner, assistantTainted, expectedOrigin) => {
      memoryProvenanceMocks.recordMemoryArtifactWriteProvenance.mockClear();
      let observedWrite:
        | Parameters<
            typeof import("../../../memory/memory-artifact-provenance.js").recordMemoryArtifactWriteProvenance
          >[0]
        | undefined;
      memoryProvenanceMocks.recordMemoryArtifactWriteProvenance.mockImplementationOnce(
        async (write) => {
          observedWrite = write;
          await expectPathMissing(path.join(write.workspaceDir, write.relativePath));
        },
      );
      const events = createSessionMessages([
        {
          role: "user",
          content: "Retain this request",
          __openclaw: { senderIsOwner: userOwner },
        },
        {
          role: "assistant",
          content: "Retained response",
          ...(assistantTainted ? { __openclaw: { turnTainted: true } } : {}),
        },
      ]);
      const tempDir = await createCaseWorkspace();
      const { files, memoryContent } = await runNew({
        tempDir,
        events,
        cfg: {
          agents: { defaults: { workspace: tempDir } },
          plugins: { slots: { memory: "none" } },
        },
      });
      const filename = expectDefined(files[0], "session memory file");
      expect(files).toHaveLength(1);
      expect(memoryProvenanceMocks.recordMemoryArtifactWriteProvenance).toHaveBeenCalledOnce();
      expect(observedWrite).toMatchObject({
        workspaceDir: tempDir,
        relativePath: `memory/${filename}`,
        contentBefore: "",
        contentAfter: memoryContent,
        originClass: expectedOrigin,
      });
    },
  );

  it("does not commit session memory when provenance recording fails", async () => {
    memoryProvenanceMocks.recordMemoryArtifactWriteProvenance.mockRejectedValueOnce(
      new Error("provenance unavailable"),
    );
    const events = createSessionMessages([
      {
        role: "user",
        content: "Do not persist without provenance",
        __openclaw: { senderIsOwner: false },
      },
    ]);
    const { files } = await runNew({ events });
    expect(files).toEqual([]);
  });

  it("records and warns when transcript loading fails after reset capture", async () => {
    const sessionKey = "agent:main:main";
    vi.mocked(captureSessionMemoryTranscript).mockResolvedValueOnce({
      status: "unavailable",
      reason: "transcript projection unavailable retry later",
    });
    loggerMocks.warn.mockClear();
    const { memoryContent } = await runNew({ sessionKey, sessionId: "unavailable-transcript" });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Session transcript unavailable for memory capture",
      {
        sessionKey,
        error: "transcript projection unavailable retry later",
      },
    );
    expect(memoryContent).toContain("## Conversation Summary");
    expect(memoryContent).toContain(
      '> Transcript content was unavailable: "transcript projection unavailable retry later"',
    );
  });

  it("fills the configured memory window past ineligible tail messages", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const { memoryContent } = await runNew({
      tempDir,
      sessionId: "sqlite-filtered-tail",
      events: createSessionMessages([
        { role: "user", content: "Keep this user context" },
        { role: "assistant", content: "Keep this assistant context" },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "toolResult",
          content: `ignored tool result ${index}`,
        })),
        { role: "assistant", content: "NO_REPLY" },
      ]),
      cfg: {
        agents: { defaults: { workspace: tempDir } },
        hooks: {
          internal: {
            entries: { "session-memory": { enabled: true, messages: 2 } },
          },
        },
      },
    });
    expect(memoryContent).toContain(sessionMemoryRecord("user", "Keep this user context"));
    expect(memoryContent).toContain(
      sessionMemoryRecord("assistant", "Keep this assistant context"),
    );
    expect(memoryContent).not.toContain("ignored tool result");
    expect(memoryContent).not.toContain("NO_REPLY");
  });

  it("does not call the model provider for a filename slug by default", async () => {
    const events = createSessionMessages([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
    ]);
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

  it("uses local timezone date and fallback time in memory filenames and headers", async () => {
    await withEnvAsync({ TZ: "America/New_York" }, async () => {
      const { files, memoryContent } = await runNew({
        timestamp: new Date("2026-01-01T04:30:15.000Z"),
        sessionId: "local-time-session",
      });
      expect(files).toEqual(["2025-12-31-2330.md"]);
      expect(memoryContent).toMatch(/^# Session: 2025-12-31 23:30:15 America\/New_York/);
      expect(memoryContent).not.toContain("# Session: 2026-01-01 04:30:15 UTC");
    });
  });

  it("prefers configured user timezone over the host timezone", async () => {
    await withEnvAsync({ TZ: "America/New_York" }, async () => {
      const tempDir = await createCaseWorkspace("workspace");
      const { files, memoryContent } = await runNew({
        tempDir,
        cfg: {
          agents: { defaults: { workspace: tempDir, userTimezone: "Asia/Jakarta" } },
        },
        timestamp: new Date("2026-01-01T18:30:15.000Z"),
        sessionId: "configured-timezone-session",
      });
      expect(files).toEqual(["2026-01-02-0130.md"]);
      expect(memoryContent).toMatch(/^# Session: 2026-01-02 01:30:15 Asia\/Jakarta/);
    });
  });

  it("keeps same-minute fallback timestamp captures by adding a filename suffix", async () => {
    await withEnvAsync({ TZ: "UTC" }, async () => {
      const tempDir = await createCaseWorkspace("workspace");
      const timestamp = new Date("2026-01-01T04:30:15.000Z");
      await runNew({ tempDir, timestamp, sessionId: "first-session" });
      await runNew({ tempDir, timestamp, sessionId: "second-session" });
      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      expect(files).toHaveLength(2);
      expect(files).toContain("2026-01-01-0430.md");
      expect(files).toContain("2026-01-01-0430-2.md");

      await expect(
        fs.readFile(path.join(memoryDir, "2026-01-01-0430.md"), "utf-8"),
      ).resolves.toContain("- **Session ID**: first-session");
      await expect(
        fs.readFile(path.join(memoryDir, "2026-01-01-0430-2.md"), "utf-8"),
      ).resolves.toContain("- **Session ID**: second-session");
    });
  });

  it("prefers workspaceDir from hook context when sessionKey points at main", async () => {
    const mainWorkspace = await createCaseWorkspace("workspace-main");
    const naviWorkspace = await createCaseWorkspace("workspace-navi");
    const { files, memoryContent } = await runNew({
      tempDir: naviWorkspace,
      cfg: {
        agents: {
          defaults: { workspace: mainWorkspace },
          entries: { navi: { workspace: naviWorkspace } },
        },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      workspaceDirOverride: naviWorkspace,
      sessionId: "navi-session",
      events: createSessionMessages([
        { role: "user", content: "Remember this under Navi" },
        { role: "assistant", content: "Stored in the bound workspace" },
      ]),
    });
    expect(files.length).toBe(1);
    expect(memoryContent).toContain(sessionMemoryRecord("user", "Remember this under Navi"));
    expect(memoryContent).toContain(
      sessionMemoryRecord("assistant", "Stored in the bound workspace"),
    );
    expect(memoryContent).toContain("- **Session Key**: agent:navi:main");
    await expectPathMissing(path.join(mainWorkspace, "memory"));
  });
});
