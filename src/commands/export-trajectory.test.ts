import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../cli/failure-output.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  exportTrajectoryBundle: vi.fn(),
  getRuntimeConfig: vi.fn(),
  loadSessionEntryReadOnly: vi.fn(),
  resolveExplicitStorePath: vi.fn(),
  resolveSessionTranscriptReadTarget: vi.fn(),
  resolveStorePath: vi.fn(),
}));

// mock-isolation: Select synthetic stores without reading operator config.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("./test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "getRuntimeConfig"),
  };
});

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  mocks.resolveSessionTranscriptReadTarget.mockImplementation(
    actual.resolveSessionTranscriptReadTarget,
  );
  return {
    ...actual,
    loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
    resolveSessionTranscriptReadTarget: mocks.resolveSessionTranscriptReadTarget,
  };
});

vi.mock("../trajectory/export.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trajectory/export.js")>()),
  exportTrajectoryBundle: mocks.exportTrajectoryBundle,
}));

vi.mock("../config/sessions/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/paths.js")>()),
  resolveSessionStorePathCore: mocks.resolveStorePath,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveExplicitSessionStorePath: mocks.resolveExplicitStorePath,
}));

let runtime: ReturnType<typeof createTestRuntime>;
let workspace: string;
const workspaces = useSessionStoreTempDirs(afterAll, "openclaw-export-command-");
const sessionKey = "agent:main:telegram:direct:123";
type Options = Parameters<typeof exportTrajectoryCommand>[0];
const encode = (request: unknown) =>
  Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
const run = (options: Options = {}) =>
  exportTrajectoryCommand({ sessionKey, workspace, output: "export", ...options }, runtime);
async function expectTrajectoryFailure(options: Options, message: string) {
  const execution = run(options);
  await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
  await expect(execution).rejects.toMatchObject({
    message,
    humanOutput: message,
    machineOutput: message,
  });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(runtime.log).not.toHaveBeenCalled();
}
function expectNoSessionLookup() {
  expect(mocks.resolveStorePath).not.toHaveBeenCalled();
  expectNoReadOrExport();
}
function expectNoReadOrExport() {
  expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
  expect(mocks.exportTrajectoryBundle).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime = createTestRuntime();
  workspace = workspaces.make();
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/sessions.json");
  mocks.resolveExplicitStorePath.mockImplementation(
    (params: { storePath: string }) => params.storePath,
  );
  mocks.loadSessionEntryReadOnly.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
  mocks.exportTrajectoryBundle.mockImplementation(async ({ outputDir }: { outputDir: string }) => ({
    outputDir,
    manifest: { eventCount: 2, runtimeEventCount: 0, transcriptEventCount: 2 },
    files: ["manifest.json", "events.jsonl", "session-branch.json"],
    supplementalFiles: [],
  }));
});

it("points missing session key users at the sessions command", async () => {
  await expectTrajectoryFailure(
    { sessionKey: undefined },
    "--session-key is required. Run openclaw sessions to choose a session.",
  );
  expectNoSessionLookup();
});

it.each([
  ["malformed JSON", Buffer.from("not json", "utf8").toString("base64url"), "is invalid JSON"],
  ["a non-object JSON value", encode([]), "must be a JSON object"],
  ["nonzero padding bits", `${encode({ sessionKey: "xy" }).slice(0, -1)}R`, "is invalid"],
  ["surrounding whitespace", ` ${encode({ sessionKey: "xyz" })} `, "is invalid"],
])("rejects encoded %s before session lookup", async (_name, encoded, detail) => {
  await expectTrajectoryFailure(
    { requestJsonBase64: encoded },
    `Failed to decode trajectory export request: Encoded trajectory export request ${detail}`,
  );
  expectNoSessionLookup();
});

it.each([
  ["agent", "--agent must not be blank"],
  ["store", "--store must not be blank"],
])("rejects blank encoded %s before session lookup", async (field, message) => {
  await expectTrajectoryFailure(
    { requestJsonBase64: encode({ sessionKey, [field]: "   " }) },
    message,
  );
  expectNoSessionLookup();
});

it.each(["encoded", "configured"] as const)(
  "uses the %s session store and agent",
  async (source) => {
    const encoded = source === "encoded";
    const template = "/tmp/openclaw/agents/{agentId}/sessions/sessions.json";
    const store = encoded
      ? "/tmp/encoded-store.json"
      : "/tmp/openclaw/agents/work/sessions/sessions.json";
    mocks.getRuntimeConfig.mockReturnValue(
      encoded ? { agents: { entries: { main: {}, work: {} } } } : { session: { store: template } },
    );
    mocks.resolveStorePath.mockReturnValue(store);
    const key = encoded ? sessionKey : "agent:work:telegram:direct:123";
    await run(
      encoded
        ? { requestJsonBase64: encode({ sessionKey: key, store, agent: "work" }) }
        : { sessionKey: key },
    );
    expect(mocks.resolveStorePath).toHaveBeenCalledWith(encoded ? store : template, {
      agentId: "work",
    });
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey: key,
      storePath: store,
    });
  },
);

it("routes invalid explicit stores through the command failure owner", async () => {
  mocks.resolveStorePath.mockReturnValue("/tmp/missing.sqlite");
  mocks.resolveExplicitStorePath.mockImplementationOnce(() => {
    throw new Error("Session store target does not exist: /tmp/missing.sqlite");
  });

  await expectTrajectoryFailure(
    { store: "/tmp/missing.sqlite", json: true },
    "Session store target does not exist: /tmp/missing.sqlite",
  );

  expectNoReadOrExport();
});

it("rejects an unknown explicit agent before reading a session", async () => {
  mocks.getRuntimeConfig.mockReturnValue({ agents: { entries: { main: {} } } });
  await expectTrajectoryFailure(
    { agent: "nope-agent" },
    'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
  );
  expectNoSessionLookup();
});

it("requires an explicit owner for an ambiguous alias before reading or exporting", async () => {
  mocks.getRuntimeConfig.mockReturnValue({
    agents: { ownership: "explicit", entries: { main: {}, work: {} } },
  });

  await expect(run({ sessionKey: "global" })).rejects.toThrow("--agent <id>");

  expectNoReadOrExport();
});

it("reports a missing session without resolving its transcript or exporting", async () => {
  mocks.loadSessionEntryReadOnly.mockReturnValue(undefined);

  await expectTrajectoryFailure(
    {},
    "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
  );

  expect(mocks.resolveSessionTranscriptReadTarget).not.toHaveBeenCalled();
  expect(mocks.exportTrajectoryBundle).not.toHaveBeenCalled();
});

it("reports transcript target resolution failures without invoking the exporter", async () => {
  mocks.resolveSessionTranscriptReadTarget.mockImplementationOnce(() => {
    throw new Error("transcript target is unavailable");
  });

  await expectTrajectoryFailure(
    {},
    "Failed to resolve session file: transcript target is unavailable",
  );

  expect(mocks.exportTrajectoryBundle).not.toHaveBeenCalled();
});

it("reports exporter failures without formatting a successful result", async () => {
  mocks.exportTrajectoryBundle.mockRejectedValueOnce(new Error("workspace is unavailable"));

  await expectTrajectoryFailure({}, "Failed to export trajectory: workspace is unavailable");

  expect(runtime.log).not.toHaveBeenCalled();
});
