import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { captureLifecycleDatabaseScope } from "./session-accessor.sqlite-scope.js";

const boundary = vi.hoisted(() => ({
  state: vi.fn((databasePath: string) => ({
    assertCurrent() {},
    databasePath,
    identity: { key: databasePath },
  })),
}));

// The archive session admits the state database it captured; record that path without opening it.
vi.mock("../../state/openclaw-state-db-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db-cache.js")>()),
  captureOpenClawStateDatabaseReadAdmission: boundary.state,
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
}));
vi.mock("../../state/openclaw-agent-db-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db-resources.js")>()),
  registerOpenClawAgentDatabaseAsyncResource: () => () => {},
}));

const fixtures = [
  { platform: "win32", key: "OpenClaw_State_Dir", readonlyKey: "OpenClaw_Config_Readonly" },
  { platform: "linux", key: "OPENCLAW_STATE_DIR", readonlyKey: "OPENCLAW_CONFIG_READONLY" },
  { platform: "linux", key: "OpenClaw_State_Dir", readonlyKey: "OpenClaw_Config_Readonly" },
] as const;

const root = path.resolve("/synthetic/captured");
const home = path.resolve("/synthetic/home");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function expectedRootFor(fixture: (typeof fixtures)[number]) {
  const caseSensitiveMiss = fixture.platform === "linux" && fixture.key !== "OPENCLAW_STATE_DIR";
  return {
    caseSensitiveMiss,
    expectedRoot: caseSensitiveMiss ? path.join(home, ".openclaw") : root,
  };
}

async function expectCapturedRoot(
  fixture: (typeof fixtures)[number],
  env: NodeJS.ProcessEnv | undefined,
) {
  const { caseSensitiveMiss, expectedRoot } = expectedRootFor(fixture);
  const captured = captureLifecycleDatabaseScope({ agentId: "main", ...(env ? { env } : {}) });
  expect(captured.env.OPENCLAW_STATE_DIR).toBe(expectedRoot);
  expect(captured.env.OPENCLAW_CONFIG_READONLY).toBe(caseSensitiveMiss ? undefined : "1");
  expect(captured.path).toBe(
    resolveOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: expectedRoot },
    }),
  );

  // The archive session must pin the same state database as the lifecycle owner.
  await withSqliteTranscriptArchiveSession(
    { agentId: "main", ...(env ? { env } : {}) },
    async () => {},
  );
  expect(boundary.state).toHaveBeenCalledWith(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: expectedRoot }),
  );
}

it.each([
  ...fixtures.map((fixture) => ({ ...fixture, input: "plain" })),
  { ...fixtures[0], input: "precloned" },
])("retains $input supplied environment on $platform with $key", async (fixture) => {
  await withMockedPlatform(fixture.platform, async () => {
    const rawEnv = {
      [fixture.key]: root,
      [fixture.readonlyKey]: "1",
      HOME: home,
      OPENCLAW_TEST_FAST: "1",
    };
    const env = fixture.input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
    await expectCapturedRoot(fixture, env);
    expect(env[fixture.key]).toBe(root);
    expect(Object.keys(env)).toEqual(Object.keys(rawEnv));
  });
});

it.each(fixtures)("retains process environment on $platform with $key", async (fixture) => {
  await withMockedPlatform(fixture.platform, async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_READONLY", undefined);
    vi.stubEnv("OPENCLAW_HOME", undefined);
    vi.stubEnv(fixture.key, root);
    vi.stubEnv(fixture.readonlyKey, "1");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    await expectCapturedRoot(fixture, undefined);
    expect(process.env[fixture.key]).toBe(root);
  });
});
