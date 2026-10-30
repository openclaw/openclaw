import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { setCliSessionBinding } from "../agents/cli-session.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-fork-recovery-");
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
it("keeps a concurrent durable rebind when a stale CLI fork reports its successor", async () => {
  const root = sessionDirs.make();
  const stateDir = path.join(root, "state");
  const tmpDir = path.join(root, "tmp");
  const workspace = path.join(root, "workspace");
  const pluginDir = path.join(root, "plugin");
  const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
  const sessionKey = "agent:main:cli-fork-process";
  const sourceCliSessionId = "source-cli-session";
  const newerCliSessionId = "newer-cli-session";
  const successorCliSessionId = "stale-successor-session";
  const checkpointId = "source-checkpoint";
  const backendScript = path.join(root, "backend.mjs");
  const rebindScript = path.join(root, "rebind.mjs");
  const spawnLog = path.join(root, "spawn.jsonl");
  await Promise.all(
    [tmpDir, workspace, pluginDir].map((dir) => fs.mkdir(dir, { recursive: true })),
  );

  await Promise.all([
    writeJson(path.join(pluginDir, "package.json"), {
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "cli-fork-process-proof",
      cliBackends: ["proof-cli"],
      activation: { onStartup: false },
      modelCatalog: {
        providers: { "proof-cli": { models: [{ id: "proof-model", name: "Proof model" }] } },
        discovery: { "proof-cli": "static" },
      },
      configSchema: { type: "object", additionalProperties: false },
    }),
    fs.writeFile(
      path.join(pluginDir, "index.js"),
      `import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export default {
  id: "cli-fork-process-proof",
  register(api) {
    api.registerCliBackend({
      id: "proof-cli",
      modelProvider: "proof-cli",
      config: {
        command: process.execPath,
        args: [${JSON.stringify(backendScript)}],
        resumeArgs: [${JSON.stringify(backendScript)}, "--resume", "{sessionId}"],
        output: "json",
        resumeOutput: "json",
        input: "stdin",
        sessionMode: "existing",
        sessionIdFields: ["session_id"],
        forkArg: "--fork-session",
        resumeAtArg: "--resume-session-at",
        systemPromptWhen: "never",
        serialize: true
      },
      prepareExecution: async () => ({
        beforeExecution: () => execFileAsync(process.execPath, ["--import", "tsx", ${JSON.stringify(rebindScript)}])
      })
    });
  }
};
`,
    ),
    fs.writeFile(
      backendScript,
      `import fs from "node:fs/promises";
for await (const _chunk of process.stdin) {}
await fs.appendFile(${JSON.stringify(spawnLog)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ result: "stale recovery ran", session_id: ${JSON.stringify(successorCliSessionId)} }) + "\\n");
`,
    ),
    fs.writeFile(
      rebindScript,
      `const accessor = await import(${JSON.stringify(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.sessionAccessor).href)});
const cliSession = await import(${JSON.stringify(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cliSession).href)});
const scope = { sessionKey: ${JSON.stringify(sessionKey)}, storePath: ${JSON.stringify(storePath)} };
const current = accessor.loadSessionEntry({ ...scope, readConsistency: "latest" });
if (!current) throw new Error("proof session row missing");
const rebound = structuredClone(current);
cliSession.setCliSessionBinding(rebound, "proof-cli", { sessionId: ${JSON.stringify(newerCliSessionId)}, forceReuse: true });
if (!await accessor.replaceSessionEntry(scope, rebound)) throw new Error("proof rebind failed");
`,
    ),
  ]);
  const fixture = createCliProcessFixture(root, {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
    TMPDIR: tmpDir,
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_ENV: undefined,
    NODE_OPTIONS: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: root,
    OPENCLAW_NO_RESPAWN: "1",
    VITEST: undefined,
  });
  const { env } = fixture;
  await fixture.writeConfig({
    session: { store: path.join(stateDir, "agents/{agentId}/sessions/sessions.json") },
    plugins: {
      allow: ["cli-fork-process-proof"],
      load: { paths: [pluginDir] },
      entries: { "cli-fork-process-proof": { enabled: true } },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: "proof-cli/proof-model" },
        models: { "proof-cli/proof-model": { agentRuntime: { id: "proof-cli" } } },
      },
    },
  });

  const entry = {
    sessionId: "openclaw-process-session",
    lifecycleRevision: "process-lifecycle",
    activeWriterRunId: "process-writer",
    updatedAt: 1,
  };
  setCliSessionBinding(entry, "proof-cli", {
    sessionId: sourceCliSessionId,
    forceReuse: true,
    forkNextResume: true,
    resumeCheckpointId: checkpointId,
  });
  await replaceSessionEntry({ sessionKey, storePath, env }, entry);
  closeOpenClawAgentDatabasesForTest();

  const result = await fixture.run([
    "agent",
    "--local",
    "--session-key",
    sessionKey,
    "--model",
    "proof-cli/proof-model",
    "--message",
    "prove stale fork ownership",
    "--json",
  ]);

  expect(result, JSON.stringify(result)).toMatchObject({ code: 1, signal: null });
  expect(result.stderr).toContain(
    "SQLite session state changed while preparing session-entry.patch",
  );
  closeOpenClawAgentDatabasesForTest();
  expect(
    loadSessionEntryReadOnly({ sessionKey, storePath, env })?.cliSessionBindings?.["proof-cli"]
      ?.sessionId,
  ).toBe(newerCliSessionId);
  expect(JSON.parse((await fs.readFile(spawnLog, "utf8")).trim())).toHaveProperty("argv", [
    "--resume",
    sourceCliSessionId,
    "--fork-session",
    "--resume-session-at",
    checkpointId,
  ]);
});
