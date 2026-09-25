import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { testState } from "./test-helpers.js";
import { resetPersistentGatewaySessionStore } from "./test/persistent-session-store.test-support.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
} from "./test/server-sessions.test-helpers.js";

type EnsureSessionDiffBaseline =
  (typeof import("../sessions/session-diff-baseline.js"))["ensureSessionDiffBaseline"];
type CaptureSessionDiffBaseline =
  (typeof import("../sessions/session-diff.js"))["captureSessionDiffBaseline"];
type GenerateConversationLabelWithFallback =
  (typeof import("../auto-reply/reply/conversation-label-generator.js"))["generateConversationLabelWithFallback"];
type ScheduleChatDashboardSessionTitle =
  (typeof import("./server-methods/chat-send-background.js"))["scheduleChatDashboardSessionTitle"];

const sessionDiffBaselineMocks = vi.hoisted(() => ({
  captureGate: undefined as Promise<void> | undefined,
  captureStarted: undefined as (() => void) | undefined,
  capture: vi.fn<CaptureSessionDiffBaseline>(),
  ensure: vi.fn<EnsureSessionDiffBaseline>(),
  useReal: false,
}));

const dashboardTitleGenerationMocks = vi.hoisted(() => ({
  generate: vi.fn<GenerateConversationLabelWithFallback>(),
}));

const dashboardTitleScheduleMocks = vi.hoisted(() => ({
  schedule: vi.fn<ScheduleChatDashboardSessionTitle>(),
}));

vi.mock("../sessions/session-diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-diff.js")>();
  sessionDiffBaselineMocks.capture.mockImplementation(async (params) => {
    sessionDiffBaselineMocks.captureStarted?.();
    if (sessionDiffBaselineMocks.captureGate) {
      await sessionDiffBaselineMocks.captureGate;
    }
    return await actual.captureSessionDiffBaseline(params);
  });
  return { ...actual, captureSessionDiffBaseline: sessionDiffBaselineMocks.capture };
});

vi.mock("../sessions/session-diff-baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-diff-baseline.js")>();
  sessionDiffBaselineMocks.ensure.mockImplementation(async (params) => {
    return sessionDiffBaselineMocks.useReal
      ? await actual.ensureSessionDiffBaseline(params)
      : params.entry;
  });
  return { ...actual, ensureSessionDiffBaseline: sessionDiffBaselineMocks.ensure };
});

vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: dashboardTitleGenerationMocks.generate,
}));

vi.mock("./server-methods/chat-send-background.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-methods/chat-send-background.js")>();
  return { ...actual, scheduleChatDashboardSessionTitle: dashboardTitleScheduleMocks.schedule };
});

// Shared Gateway helpers must register dispatch and lifecycle mocks before this graph loads.
const chatSendOwner = await import("./server-methods/chat-send-external-entry.js");

// Read the real implementations back here rather than capturing them inside the
// mock factories: Vitest runs a factory on first import of the mocked module, and
// this project is `isolate: false`, so on a warm module graph a factory can still
// be unrun when the first `beforeEach` fires.
async function actualDashboardTitleScheduler(): Promise<ScheduleChatDashboardSessionTitle> {
  const actual = await vi.importActual<typeof import("./server-methods/chat-send-background.js")>(
    "./server-methods/chat-send-background.js",
  );
  return actual.scheduleChatDashboardSessionTitle;
}

export function setupSessionCreateTestHarness(
  setup?: Parameters<typeof setupGatewaySessionsTestHarness>[0],
) {
  const fixture = setupGatewaySessionsTestHarness(setup);
  beforeEach(async () => {
    sessionDiffBaselineMocks.captureGate = undefined;
    sessionDiffBaselineMocks.captureStarted = undefined;
    sessionDiffBaselineMocks.capture.mockClear();
    sessionDiffBaselineMocks.ensure.mockClear();
    // The worktree suite exercises real baseline capture through authenticated requests.
    sessionDiffBaselineMocks.useReal = false;
    dashboardTitleGenerationMocks.generate.mockReset();
    dashboardTitleGenerationMocks.generate.mockResolvedValue("Generated Dashboard Title");
    dashboardTitleScheduleMocks.schedule.mockReset();
    dashboardTitleScheduleMocks.schedule.mockImplementation(await actualDashboardTitleScheduler());
  });
  return fixture;
}

/** Ordinary main-session lifecycle cases can reset rows without reopening their store. */
export function setupPersistentSessionCreateTestHarness() {
  let dir: string | undefined;
  setupSessionCreateTestHarness(async (makeTempDir) => {
    dir = await fs.realpath(makeTempDir("openclaw-session-create-persistent-"));
  });
  afterEach(async () => {
    if (!dir) {
      return;
    }
    await resetPersistentGatewaySessionStore(dir);
  });
  return {
    createSessionStoreDir: async () => {
      if (!dir) {
        throw new Error("Persistent session fixture was not created");
      }
      const storePath = path.join(dir, "sessions.json");
      testState.sessionStorePath = storePath;
      (await getGatewayConfigModule()).clearRuntimeConfigSnapshot();
      return { dir, storePath };
    },
  };
}

function requireNonEmptyString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function removeSessionWorktree(key: string | undefined) {
  const worktree = key ? managedWorktrees.findLiveByOwner("session", key) : undefined;
  if (worktree) {
    await managedWorktrees.remove({
      id: worktree.id,
      reason: "test-cleanup",
      allowSnapshotLoss: true,
    });
  }
}

async function withFixedOwnerSessionStore(
  createSessionStoreDir: ReturnType<
    typeof setupGatewaySessionsTestHarness
  >["createSessionStoreDir"],
  scope: "global" | "per-sender",
  run: (fixture: { storePath: string; cfg: ReturnType<typeof getRuntimeConfig> }) => Promise<void>,
) {
  const config = await getGatewayConfigModule();
  const runtime = config.getRuntimeConfigSnapshot();
  const source = config.getRuntimeConfigSourceSnapshot();
  const previous = {
    agentsConfig: testState.agentsConfig,
    agentConfig: testState.agentConfig,
    sessionConfig: testState.sessionConfig,
    sessionStorePath: testState.sessionStorePath,
  };
  const configPaths = new Set([config.CONFIG_PATH]);
  if (process.env.OPENCLAW_CONFIG_PATH) {
    configPaths.add(process.env.OPENCLAW_CONFIG_PATH);
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    configPaths.add(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"));
  }
  const files = new Map<string, Buffer | undefined>();
  for (const configPath of configPaths) {
    try {
      files.set(configPath, await fs.readFile(configPath));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      files.set(configPath, undefined);
    }
  }
  try {
    const { storePath } = await createSessionStoreDir();
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, ops: {} } };
    testState.agentConfig = { sessionStore: { agentId: "main" } };
    testState.sessionConfig = { scope };
    await run({ storePath, cfg: config.getRuntimeConfig() });
  } finally {
    Object.assign(testState, previous);
    // Opening a wire client persists fixture config; restore it before the next case.
    for (const [configPath, contents] of files) {
      if (contents === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, contents);
      }
    }
    if (runtime) {
      config.setRuntimeConfigSnapshot(runtime, source ?? undefined);
    } else {
      config.clearRuntimeConfigSnapshot();
    }
  }
}

export {
  sessionDiffBaselineMocks,
  dashboardTitleGenerationMocks,
  dashboardTitleScheduleMocks,
  chatSendOwner,
  actualDashboardTitleScheduler,
  requireNonEmptyString,
  removeSessionWorktree,
  withFixedOwnerSessionStore,
};
