import fs from "node:fs";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import { containsObjects } from "./doctor-session-sqlite.publication-spies.test-support.js";
import type { TestStore } from "./doctor-session-sqlite.test-support.js";

export function expectIssue(report: DoctorSessionSqliteReport, shape: Record<string, unknown>) {
  containsObjects(
    report.targets.flatMap((target) => target.issues),
    shape,
  );
}

export function messageEvent(
  id: string,
  role: string,
  content: string,
  parentId: string | null = null,
) {
  return { type: "message", id, parentId, message: { role, content } };
}

export function writePrivateFile(file: string, contents: string | Uint8Array) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

export function writeJson(file: string, value: unknown, space?: number) {
  writePrivateFile(file, JSON.stringify(value, null, space));
}

export function sessionScope(store: TestStore, agentId = "main") {
  return {
    agentId,
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath: store.storePath,
    env: store.env,
  };
}

export function runStoreDoctor(store: TestStore, mode: DoctorSessionSqliteMode) {
  return runDoctorSessionSqlite({ env: store.env, store: store.storePath, mode });
}

export async function seedRetainedSource(
  state: OpenClawTestState,
  layout: "default" | "external" = "default",
  pluginId = "fixture-plugin",
) {
  const fixture = await seedDeferredPluginSessionSource(state, layout, pluginId);
  const options = { cfg: fixture.cfg, env: state.env, allAgents: true };
  return {
    ...fixture,
    run: (mode: DoctorSessionSqliteMode = "import") => runDoctorSessionSqlite({ ...options, mode }),
    readEntry: (sessionKey: string) => loadExactSessionEntry({ ...fixture.scope, sessionKey }),
    readEvents: (sessionId: string) => loadTranscriptEventsSync({ ...fixture.scope, sessionId }),
  };
}
