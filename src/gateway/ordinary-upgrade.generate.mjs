// Run with the pinned main checkout's TS loader; all runtime imports come from that checkout.
// node --import <main>/scripts/tsx.mjs ordinary-upgrade.generate.mjs <main> <empty-state> <fixture>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const [baseline, root, output] = process.argv.slice(2);
const commit = "a10e445719a65729e73abd835c774c716aba752d";
assert.equal(
  execFileSync("git", ["-C", baseline, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  commit,
);
assert.equal(
  execFileSync("git", ["-C", baseline, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim(),
  "",
);
await fs.mkdir(root, { recursive: false, mode: 0o700 });
process.env.HOME = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
const load = (file) => import(pathToFileURL(path.join(baseline, file)).href);
const { setRuntimeConfigSnapshot } = await load("src/config/runtime-snapshot.ts");
const { ensureUserProfilesSchema } = await load("src/state/user-profiles-schema.ts");
const { ensureProfileForEmail } = await load("src/state/user-profiles.ts");
const { prepareUserProfileCatalog } = await load("src/state/user-profile-list.ts");
const { prepareGatewayOperatorRunAuthority } = await load("src/gateway/operator-run-authority.ts");
const { captureGatewayAuthPolicy } = await load("src/gateway/auth-policy.ts");
const { captureQueuedOperatorRecoverySource } = await load(
  "src/gateway/operator-run-recovery-source.ts",
);
const { captureScheduledOperatorSource } = await load("src/agents/operator-run-recovery-source.ts");
const { replaceSessionEntry } = await load("src/config/sessions/session-accessor.ts");
const { preparePendingInputStore } = await load(
  "src/config/sessions/session-pending-input-store.ts",
);
const { readSessionQueuedInputPage } = await load(
  "src/config/sessions/session-pending-input-history.ts",
);
const { CronService } = await load("src/cron/service.ts");
const { GatewayScheduler } = await load("src/infra/gateway-scheduler.ts");
const { resolveCronOperatorExecutionRevision } = await load("src/cron/service/jobs-tool-policy.ts");
const { closeOpenClawAgentDatabasesAsync } = await load("src/state/openclaw-agent-db-lifecycle.ts");
const { closeOpenClawStateDatabaseAsync } = await load("src/state/openclaw-state-db-cache.ts");
const cfg = { agents: { entries: { main: {} } }, cron: { enabled: false } };
setRuntimeConfigSnapshot(cfg);
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
ensureUserProfilesSchema({});
const profile = ensureProfileForEmail("ordinary-upgrade-owner@example.test");
const catalog = await prepareUserProfileCatalog();
const context = { getRuntimeConfig: () => cfg };
context.resolveGatewayContext = () => context;
const client = {
  connId: "ordinary-upgrade-owner",
  authenticatedUserProfile: {
    profileId: profile.id,
    displayName: null,
    hasAvatar: false,
    updatedAt: 1,
  },
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.admin"],
    client: { id: "openclaw-control-ui", version: "fixture", platform: "test", mode: "webchat" },
  },
  internal: { authenticatedOperator: true, controlUiAdmin: true, isLocalClient: true },
  authPolicy: captureGatewayAuthPolicy(cfg, { role: "operator", authMethod: "token" }),
};
const prepared = await prepareGatewayOperatorRunAuthority({
  client,
  context,
  sourceAuthority: null,
});
assert(prepared?.authority.recoverySnapshot);
const scope = {
  agentId: "main",
  sessionKey: "agent:main:ordinary-upgrade",
  sessionId: "ordinary-upgrade-session",
};
const entry = {
  sessionId: scope.sessionId,
  updatedAt: 1,
  status: "done",
  createdActor: { type: "human", source: "profile", id: profile.id },
};
await replaceSessionEntry(scope, entry);
const queuedSource = captureQueuedOperatorRecoverySource(prepared.authority);
assert.equal(queuedSource.kind, "gateway");
assert.equal(queuedSource.snapshot.version, undefined);
const inputId = "ordinary-upgrade-input";
const runId = "ordinary-upgrade-queued-run";
const store = await preparePendingInputStore(scope, () => {});
try {
  const identity = {
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    idempotencyKey: runId,
  };
  const expected = await store.read({ ...identity, kind: "stage", trackCompletion: true });
  await store.mutate(
    {
      ...identity,
      kind: "stage",
      expected,
      trackCompletion: true,
      inputId,
      runId,
      requestHash: "request:ordinary-upgrade",
      lifecycleGeneration: "main-writer-generation",
      messageJson: JSON.stringify({
        role: "user",
        content: "MAIN_WRITTEN_QUEUED_INPUT",
        timestamp: 1,
        idempotencyKey: runId,
        __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
      }),
      originSourceJson: JSON.stringify(queuedSource),
    },
    () => {},
  );
} finally {
  await store.release();
}
const queued = (await readSessionQueuedInputPage(scope)).rows;
assert.equal(queued.length, 1);
const source = captureScheduledOperatorSource({
  authority: prepared.authority,
  entry,
  agentId: scope.agentId,
  sessionKey: scope.sessionKey,
  sourceRunId: "ordinary-upgrade-creator-run",
});
assert(source);
const cronStorePath = path.join(root, "cron", "jobs.json");
const scheduler = new GatewayScheduler();
const cron = new CronService({
  scheduler,
  storePath: cronStorePath,
  cronEnabled: false,
  log: { debug() {}, info() {}, warn() {}, error() {} },
});
const definition = {
  name: "Main-written ordinary automation",
  agentId: "main",
  enabled: false,
  schedule: { kind: "every", everyMs: 86400000, anchorMs: 1 },
  sessionTarget: `session:${scope.sessionKey}`,
  sessionKey: scope.sessionKey,
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "MAIN_WRITTEN_CRON_INPUT" },
  delivery: { mode: "none" },
  owner: { sessionKey: scope.sessionKey, accountId: "default" },
};
const scheduledToolPolicy = {
  version: 1,
  mode: "account",
  ownerSessionKey: scope.sessionKey,
  ownerAccountId: "default",
};
const job = await cron.add(definition, { createdActor: entry.createdActor, scheduledToolPolicy });
const updated = await cron.update(
  job.id,
  {},
  {
    scheduledToolPolicy,
    operatorSource: source,
    operatorSourceExecutionRevision: resolveCronOperatorExecutionRevision(job),
  },
);
assert(updated.operatorSource, "main cron writer must retain the captured source");
prepared.release();
catalog.release();
cron.stop();
await cron.waitForIdle();
await scheduler.stop();
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
const files = {};
for (const relative of ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"]) {
  files[relative] = gzipSync(await fs.readFile(path.join(root, relative))).toString("base64");
}
await fs.writeFile(
  output,
  `${JSON.stringify({ commit, cfg, scope, profileId: profile.id, cronStorePath, queued, job: updated, files }, null, 2)}\n`,
);
console.log(JSON.stringify({ commit, output, queuedInputId: inputId, cronJobId: job.id }));
