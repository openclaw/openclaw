import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../config/sessions/paths.js";
import { evaluateSessionStoreSize } from "./doctor-session-store-size.js";

type EnvSnapshot = {
  HOME?: string;
  OPENCLAW_HOME?: string;
  OPENCLAW_STATE_DIR?: string;
};

function captureEnv(): EnvSnapshot {
  return {
    HOME: process.env.HOME,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const key of Object.keys(snapshot) as Array<keyof EnvSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function seedStore(
  cfg: OpenClawConfig,
  entries: Record<string, { sessionId: string; updatedAt: number }>,
) {
  const agentId = "main";
  const storePath = resolveStorePath(cfg.session?.store, { agentId, env: process.env });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2));
}

function seedTranscriptFiles(count: number) {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(
    "main",
    process.env,
    () => process.env.HOME ?? "",
  );
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(
      path.join(sessionsDir, `00000000-0000-0000-0000-${String(i).padStart(12, "0")}.jsonl`),
      "",
    );
  }
}

function buildEntries(count: number) {
  const out: Record<string, { sessionId: string; updatedAt: number }> = {};
  for (let i = 0; i < count; i += 1) {
    out[`agent:main:${String(i).padStart(8, "0")}`] = {
      sessionId: `sess-${i}`,
      updatedAt: i,
    };
  }
  return out;
}

describe("doctor session-store-size health check", () => {
  let envSnapshot: EnvSnapshot;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-store-size-"));
    process.env.HOME = tempHome;
    process.env.OPENCLAW_HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
    fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("emits no warning when the store and sessions dir are within thresholds", () => {
    const cfg: OpenClawConfig = {};
    seedStore(cfg, buildEntries(50));
    seedTranscriptFiles(50);
    const { warnings } = evaluateSessionStoreSize({ cfg, env: process.env });
    expect(warnings).toEqual([]);
  });

  it("emits no warning when there is no store file yet", () => {
    const cfg: OpenClawConfig = {};
    const { warnings } = evaluateSessionStoreSize({ cfg, env: process.env });
    expect(warnings).toEqual([]);
  });

  it("warns when store entry count reaches the configured maxEntries cap", () => {
    const cfg: OpenClawConfig = {
      session: { maintenance: { mode: "enforce", maxEntries: 100 } },
    };
    seedStore(cfg, buildEntries(100));
    seedTranscriptFiles(10);
    const { warnings } = evaluateSessionStoreSize({ cfg, env: process.env });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Agent "main" session store has 100 entries');
    expect(warnings[0]).toContain("maxEntries=100");
    expect(warnings[0]).toContain("openclaw sessions cleanup --enforce --fix-missing");
    // mode is already enforce, so do not nag about switching it on.
    expect(warnings[0]).not.toContain("session.maintenance.mode enforce");
  });

  it("warns when the sessions directory has accumulated many transcripts even with a small store", () => {
    const cfg: OpenClawConfig = {
      session: { maintenance: { mode: "enforce", maxEntries: 5_000 } },
    };
    seedStore(cfg, buildEntries(10));
    seedTranscriptFiles(2_000);
    const { warnings } = evaluateSessionStoreSize({ cfg, env: process.env });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2000 transcript files");
    expect(warnings[0]).toContain("openclaw sessions cleanup --enforce --fix-missing");
  });

  it("adds a mode hint when maintenance is in warn mode and the store is large", () => {
    const cfg: OpenClawConfig = {
      session: { maintenance: { mode: "warn", maxEntries: 100 } },
    };
    seedStore(cfg, buildEntries(150));
    seedTranscriptFiles(5);
    const { warnings } = evaluateSessionStoreSize({ cfg, env: process.env });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Maintenance mode is "warn"/);
    expect(warnings[0]).toContain("openclaw config set session.maintenance.mode enforce");
  });
});
