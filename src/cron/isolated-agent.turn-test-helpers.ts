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
  writeSessionStore,
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

export function mockEmbeddedOk() {
  vi.mocked(runEmbeddedAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

export async function readCronSessionEntry(storePath: string, key: string) {
  return loadSessionEntry({ storePath, sessionKey: key });
}

export const DEFAULT_MESSAGE = "do it";

type RunCronTurnOptions = {
  cfgOverrides?: Parameters<typeof makeCfg>[2];
  deps?: CliDeps;
  jobPayload?: CronJob["payload"];
  sessionKey?: string;
  storePath?: string;
};

export async function runCronTurn(home: string, options: RunCronTurnOptions = {}) {
  const storePath = options.storePath ?? path.join(home, ".openclaw", "sessions", "sessions.json");
  const cfg = makeCfg(home, storePath, options.cfgOverrides);
  setRuntimeConfigSnapshot(cfg);
  if (!options.storePath) {
    await writeSessionStore(home, { delivery: { kind: "internal" } });
  }
  const deps = options.deps ?? makeDeps();
  mockEmbeddedOk();

  const jobPayload: CronJob["payload"] = options.jobPayload ?? {
    kind: "agentTurn",
    message: DEFAULT_MESSAGE,
  };
  const res = await runCronIsolatedAgentTurn({
    deliveryAttemptFence: null,
    cfg,
    deps,
    job: { ...makeJob(jobPayload), delivery: { mode: "none" } },
    message: jobPayload.kind === "agentTurn" ? jobPayload.message : DEFAULT_MESSAGE,
    sessionKey: options.sessionKey ?? "cron:job-1",
    lane: "cron",
  });

  return { deps, res, storePath };
}
