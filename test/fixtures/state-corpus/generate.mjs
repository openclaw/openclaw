import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prior checkout's TypeScript loader after its baseline setup.
const [checkout, release, output] = process.argv.slice(2);
assert(checkout && release && output);
assert.equal(process.env.OPENCLAW_STATE_DIR, "/home/fixture/.openclaw");
const stateDir = process.env.OPENCLAW_STATE_DIR;
const load = (name) => import(pathToFileURL(path.join(checkout, "src", name)).href);
const { createSessionEntryWithTranscript } = await load(
  "config/sessions/session-accessor.entry-mutation.ts",
);
const { appendTranscriptMessage } = await load("config/sessions/session-accessor.transcript.ts");
const { upsertAuthProfile } = await load("agents/auth-profiles/profiles.ts");
const { saveCronJobsStore, resolveCronJobsStorePath } = await load("cron/store.ts");
const { writeConfigMachineState } = await load(
  release === "2026.9.2" ? "state/config-machine-state.ts" : "state/config-machine-state-write.ts",
);
const { ensureProfileForEmail } = await load("state/user-profiles.ts");
const { setUserPreferences } = await load("state/user-preferences.ts");
const timestamp = 1788393600000;
const sessions = [];
for (const [index, name] of ["one", "two"].entries()) {
  const session = {
    agentId: "main",
    sessionKey: `agent:main:corpus-${name}`,
    sessionId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    transcriptText: `Synthetic upgrade-state message ${name}`,
  };
  const result = await createSessionEntryWithTranscript(
    { agentId: session.agentId, sessionKey: session.sessionKey },
    () => ({
      ok: true,
      entry: { sessionId: session.sessionId, updatedAt: timestamp, label: `Corpus ${name}` },
    }),
    { cwd: "/home/fixture/workspace" },
  );
  assert.equal(result.ok, true);
  await appendTranscriptMessage(session, {
    message: { role: "user", content: [{ type: "text", text: session.transcriptText }], timestamp },
    now: timestamp,
  });
  sessions.push(session);
}
const profiles = {
  "openai:corpus-api": { type: "api_key", provider: "openai", key: "fixture-api-key" },
  "openai:corpus-oauth": {
    type: "oauth",
    provider: "openai",
    access: "fixture-oauth-access",
    refresh: "fixture-oauth-refresh",
    expires: 4102444800000,
  },
  "anthropic:claude-cli": {
    type: "oauth",
    provider: "anthropic",
    access: "fixture-cli-access",
    refresh: "fixture-cli-refresh",
    expires: 4102444800000,
    subscriptionType: "pro",
    rateLimitTier: "default",
  },
};
for (const [profileId, credential] of Object.entries(profiles)) {
  upsertAuthProfile({ agentDir: path.join(stateDir, "agents/main/agent"), profileId, credential });
}
const cronStorePath = resolveCronJobsStorePath();
const cronJob = {
  id: "corpus-disabled-job",
  name: "Corpus disabled reminder",
  enabled: false,
  schedule: { kind: "every", everyMs: 86400000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "Synthetic upgrade reminder" },
};
await saveCronJobsStore(cronStorePath, {
  version: 1,
  jobs: [{ ...cronJob, createdAtMs: timestamp, updatedAtMs: timestamp, state: {} }],
});
// Cron's released partition key is an absolute logical path. Retain its selection
// through the existing machine-state owner when the fixture directory is copied.
writeConfigMachineState("cron.store", cronStorePath);
const profile = ensureProfileForEmail("fixture@example.invalid");
const controlUi = { userId: profile.id, settings: { "ui.themeMode": "dark" } };
assert.equal(setUserPreferences(controlUi.userId, controlUi.settings).ok, true);
const { closeAuthProfileReadPool } = await load("agents/auth-profiles/sqlite.ts");
const { closeOpenClawAgentDatabases } = await load("state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabase } = await load("state/openclaw-state-db.ts");
closeAuthProfileReadPool();
closeOpenClawAgentDatabases();
closeOpenClawStateDatabase();
await fs.mkdir(output, { recursive: true });
await fs.writeFile(
  path.join(output, "manifest.json"),
  `${JSON.stringify(
    {
      release,
      source: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim(),
      sessions,
      profiles,
      cronJob,
      cronStorePath,
      controlUi,
    },
    null,
    2,
  )}\n`,
);
await fs.cp(stateDir, path.join(output, "state"), { recursive: true });
console.log(
  JSON.stringify({
    release,
    sessions: sessions.length,
    profiles: Object.keys(profiles).length,
    output,
  }),
);
