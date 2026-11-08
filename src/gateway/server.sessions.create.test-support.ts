import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { testState } from "./test-helpers.js";
import { resetPersistentGatewaySessionStore } from "./test/persistent-session-store.test-support.js";
import {
  setupGatewaySessionsTestHarness,
  setupGatewaySessionsHandlerTestHarness,
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
  sessionDiffBaselineMocks.ensure.mockImplementation(async (params) =>
    sessionDiffBaselineMocks.useReal
      ? await actual.ensureSessionDiffBaseline(params)
      : params.entry,
  );
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
export const chatSendOwner = await import("./server-methods/chat-send-external-entry.js");

// With isolate:false a warm graph can reach beforeEach before the mock factory runs.
export async function actualDashboardTitleScheduler(): Promise<ScheduleChatDashboardSessionTitle> {
  const actual = await vi.importActual<typeof import("./server-methods/chat-send-background.js")>(
    "./server-methods/chat-send-background.js",
  );
  return actual.scheduleChatDashboardSessionTitle;
}

export function setupSessionCreateTestHarness(
  setup?: Parameters<typeof setupGatewaySessionsTestHarness>[0],
) {
  const fixture = setupGatewaySessionsTestHarness(async (makeTempDir) => {
    await setup?.(makeTempDir);
    // Load the lazy creation family before wire requests start their response deadline.
    await import("./server-methods/sessions-create.js");
  });
  installSessionCreateTestMocks();
  return fixture;
}

/** Direct handlers with nested state must not retain a Gateway on a different state root. */
export function setupSessionCreateHandlerTestHarness(
  setup?: Parameters<typeof setupGatewaySessionsHandlerTestHarness>[0],
) {
  const fixture = setupGatewaySessionsHandlerTestHarness(setup);
  installSessionCreateTestMocks();
  return fixture;
}

function installSessionCreateTestMocks() {
  beforeEach(async () => {
    sessionDiffBaselineMocks.captureGate = undefined;
    sessionDiffBaselineMocks.captureStarted = undefined;
    sessionDiffBaselineMocks.capture.mockClear();
    sessionDiffBaselineMocks.ensure.mockClear();
    sessionDiffBaselineMocks.useReal = false;
    dashboardTitleGenerationMocks.generate
      .mockReset()
      .mockResolvedValue("Generated Dashboard Title");
    dashboardTitleScheduleMocks.schedule
      .mockReset()
      .mockImplementation(await actualDashboardTitleScheduler());
  });
}

/** Ordinary main-session lifecycle cases can reset rows without reopening their store. */
export function setupPersistentSessionCreateTestHarness() {
  let dir: string | undefined;
  const { openClient } = setupSessionCreateTestHarness(async (makeTempDir) => {
    dir = await fs.realpath(makeTempDir("openclaw-session-create-persistent-"));
  });
  afterEach(async () => {
    if (dir) {
      await resetPersistentGatewaySessionStore(dir);
    }
  });
  return {
    openClient,
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

export function requireNonEmptyString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export async function removeSessionWorktree(key: string | undefined) {
  const { removeOwnedSessionWorktree } =
    await import("./server.sessions.create.projects.test-support.js");
  await removeOwnedSessionWorktree(key);
}

export async function withFixedOwnerSessionStore(
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
    config.setRuntimeConfigSnapshot(loadGatewayTestConfig());
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

export function sessionCreateRuntimeClient(scopes: string[]) {
  return {
    connect: { scopes },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    },
  };
}

export { sessionDiffBaselineMocks, dashboardTitleGenerationMocks, dashboardTitleScheduleMocks };

export function createGuestSandboxSessionConfig(storePath: string, others: "none" | "view") {
  return {
    ...getRuntimeConfig(),
    session: { ...getRuntimeConfig().session, store: storePath },
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others },
            agents: ["main"],
            scopes: ["operator.read" as const, "operator.write" as const],
            sandbox: "required" as const,
          },
        },
      },
    },
  };
}
