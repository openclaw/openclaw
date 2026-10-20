/** Reusable turn-level fixtures for isolated cron agent regression tests. */
import "./isolated-agent.mocks.js";
import path from "node:path";
import { vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import type { CliDeps } from "../cli/deps.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome as withTempHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import type { CronJob } from "./types.js";

export { withTempHome };

export function makeDeps(): CliDeps {
  return {
    slack: vi.fn(),
    whatsapp: vi.fn(),
    telegram: vi.fn(),
    discord: vi.fn(),
    signal: vi.fn(),
    imessage: vi.fn(),
  };
}

function mockEmbeddedTexts(texts: string[]) {
  vi.mocked(runEmbeddedAgent).mockResolvedValue({
    payloads: texts.map((text) => ({ text })),
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

export function mockEmbeddedOk() {
  mockEmbeddedTexts(["ok"]);
}

export async function readCronSessionEntry(storePath: string, key: string) {
  return loadSessionEntry({ storePath, sessionKey: key });
}

export const DEFAULT_MESSAGE = "do it";

type RunCronTurnOptions = {
  cfgOverrides?: Parameters<typeof makeCfg>[2];
  deps?: CliDeps;
  delivery?: CronJob["delivery"];
  jobPayload?: CronJob["payload"];
  message?: string;
  mockTexts?: string[] | null;
  sessionKey?: string;
  storeEntries?: Record<string, Record<string, unknown>>;
  storePath?: string;
};

export async function runCronTurn(home: string, options: RunCronTurnOptions = {}) {
  const storePath = options.storePath ?? path.join(home, ".openclaw", "sessions", "sessions.json");
  const cfg = makeCfg(home, storePath, options.cfgOverrides);
  setRuntimeConfigSnapshot(cfg);
  if (!options.storePath) {
    await writeSessionStoreEntries(home, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now(),
        delivery: { kind: "internal" },
      },
      ...options.storeEntries,
    });
  }
  const deps = options.deps ?? makeDeps();
  if (options.mockTexts === null) {
    vi.mocked(runEmbeddedAgent).mockClear();
  } else {
    mockEmbeddedTexts(options.mockTexts ?? ["ok"]);
  }

  const jobPayload: CronJob["payload"] = options.jobPayload ?? {
    kind: "agentTurn",
    message: DEFAULT_MESSAGE,
  };
  const res = await runCronIsolatedAgentTurn({
    deliveryAttemptFence: null,
    cfg,
    deps,
    job: {
      ...makeJob(jobPayload),
      delivery: options.delivery ?? { mode: "none" },
    },
    message:
      options.message ?? (jobPayload.kind === "agentTurn" ? jobPayload.message : DEFAULT_MESSAGE),
    sessionKey: options.sessionKey ?? "cron:job-1",
    lane: "cron",
  });

  return { deps, res, storePath };
}
