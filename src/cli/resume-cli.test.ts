import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { startMinimalRealGateway } from "../gateway/minimal-gateway.test-helpers.js";
import { ExitError } from "../runtime.js";
import { encodeResumeHandoff } from "../shared/resume-handoff.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import { registerResumeCli } from "./resume-cli.js";
import { runResumeCommand } from "./resume-cli.runtime.js";
import { waitForSignalExitBarriers } from "./signal-exit-barrier.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  runTui: vi.fn(),
  selectStyled: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/prompt-select-styled.js", () => ({
  selectStyled: mocks.selectStyled,
}));

vi.mock("../tui/gateway-chat.js", () => ({
  GatewayChatClient: { connect: mocks.connect },
}));

vi.mock("../tui/tui.js", () => ({
  resolveGatewayDisconnectState: vi.fn(),
  runTui: mocks.runTui,
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks,
}));

type SessionRow = TuiSessionList["sessions"][number];

const tty = createCliTtyMock();
const unresolvedHandoff =
  "Could not resolve the session handoff. Copy a fresh command from the Control UI.";
const session = { key: "agent:main:alpha", displayName: "Alpha planning", label: "roadmap" };
const resolvedConnection = {
  url: "wss://resolved.example/control",
  token: "resolved-token",
  tlsFingerprint: "sha256:resolved-pin",
};
const createHandoff = (sessionKey = session.key, gatewayUrl = "wss://gateway.example/openclaw") =>
  encodeResumeHandoff({ sessionKey, gatewayUrl });

function expectNoTui(client: ReturnType<typeof createGatewayClient>) {
  expect(client.listSessions).not.toHaveBeenCalled();
  expect(mocks.runTui).not.toHaveBeenCalled();
}

function createGatewayClient(
  rows: SessionRow[],
  connection: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
  } = { ...resolvedConnection },
) {
  const client = {
    connection,
    listSessions: vi.fn().mockResolvedValue({ sessions: rows }),
    resolveSession: vi.fn(),
    onConnected: undefined as (() => void) | undefined,
    onConnectError: undefined as ((error: Error) => void) | undefined,
    onDisconnected: undefined as ((reason: string) => void) | undefined,
    start: vi.fn(() => client.onConnected?.()),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  mocks.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  tty.set(true);
  mocks.connect.mockReset();
  mocks.runTui.mockReset().mockResolvedValue(undefined);
  mocks.selectStyled.mockReset();
  mocks.error.mockReset();
  mocks.exit.mockReset();
});

afterEach(() => tty.restore());

describe("runResumeCommand", () => {
  it.each(["cancelled", "empty"])("does not launch the TUI for a %s picker", async (scenario) => {
    const client = createGatewayClient(
      scenario === "empty" ? [] : [{ key: "agent:main:alpha", displayName: "Alpha planning" }],
    );
    mocks.selectStyled.mockResolvedValue(Symbol("cancel"));
    const result = runResumeCommand(undefined, {});
    if (scenario === "empty") {
      await expect(result).rejects.toThrow(
        "No recent sessions found. Run `openclaw sessions` to inspect sessions or `openclaw tui` to start one.",
      );
      expect(mocks.selectStyled).not.toHaveBeenCalled();
    } else {
      await result;
      expect(mocks.selectStyled).toHaveBeenCalledOnce();
    }
    expect(client.stop).toHaveBeenCalledOnce();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("reports ambiguous sessions without choosing a candidate or launching the TUI", async () => {
    const client = createGatewayClient([
      { key: "agent:main:alpha", displayName: "Alpha planning" },
      { key: "agent:main:beta", displayName: "Beta planning" },
    ]);
    await runResumeCommand("planning", {});
    expect(mocks.error.mock.calls).toEqual([
      ['Session query "planning" is ambiguous. Candidates:'],
      ["  Alpha planning (alpha) [agent:main:alpha]"],
      ["  Beta planning (beta) [agent:main:beta]"],
      ["Use a longer name or the exact session key."],
    ]);
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(mocks.selectStyled).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("rejects a handoff combined with an explicit URL", async () => {
    await expect(
      runResumeCommand(undefined, { handoff: createHandoff(), url: "wss://other.example/ws" }),
    ).rejects.toThrow("--handoff cannot be combined with a positional query or --url.");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("binds an exact handoff and explicit auth with canonical dashboard presentation", async () => {
    const sessionKey = "agent:main: hostile-'\"$&;|<>^()%![]{}\\`-%PATH% ";
    const url = "wss://gateway.example/openclaw/$&;=()+,![]{}'`/%25PATH%25";
    const client = createGatewayClient([], {
      url: "wss://normalized.example/different-path",
      token: "explicit-token",
      password: "explicit-password",
      tlsFingerprint: "sha256:explicit-pin",
    });
    client.resolveSession.mockResolvedValue({
      ok: true,
      key: sessionKey,
      agentId: "main",
      displayName: "Handoff session",
      boardFace: "dashboard",
    });

    await runResumeCommand(undefined, {
      handoff: createHandoff(sessionKey, url),
      token: "explicit-token",
      password: "explicit-password",
      tlsFingerprint: "sha256:explicit-pin",
    });

    expect(mocks.connect).toHaveBeenCalledWith({
      url,
      token: "explicit-token",
      password: "explicit-password",
      tlsFingerprint: "sha256:explicit-pin",
      allowConfiguredAuthForExactTarget: true,
      suppressEnvAuthFallback: true,
    });
    expect(client.resolveSession).toHaveBeenCalledExactlyOnceWith({
      key: sessionKey,
      agentId: "main",
      includeGlobal: true,
      allowMissing: true,
    });
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(mocks.runTui).toHaveBeenCalledWith({
      boundGateway: {
        url,
        token: "explicit-token",
        password: "explicit-password",
        tlsFingerprint: "sha256:explicit-pin",
      },
      session: sessionKey,
    });
  });

  it.each([
    ["old success without agent ownership", { ok: true, key: "agent:main:alpha" }],
    ["mismatched returned agent", { ok: true, key: "agent:main:alpha", agentId: "work" }],
    ["mismatched canonical key owner", { ok: true, key: "agent:work:alpha", agentId: "main" }],
  ])("rejects a %s handoff resolution without discovery or TUI launch", async (_name, result) => {
    const client = createGatewayClient([]);
    client.resolveSession.mockResolvedValue(result);

    await expect(runResumeCommand(undefined, { handoff: createHandoff() })).rejects.toThrow(
      "Could not resolve the session handoff.",
    );
    expectNoTui(client);
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("rejects a handoff resolution RPC error without exposing it or launching the TUI", async () => {
    const client = createGatewayClient([]);
    client.resolveSession.mockRejectedValue(new Error("sensitive upstream details"));

    await expect(runResumeCommand(undefined, { handoff: createHandoff() })).rejects.toThrow(
      unresolvedHandoff,
    );
    expectNoTui(client);
  });

  it("omits the bare global session from the interactive picker", async () => {
    const client = createGatewayClient([session]);
    mocks.selectStyled.mockResolvedValue("agent:main:alpha");

    await runResumeCommand(undefined, {});

    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeGlobal: false }),
    );
    expect(mocks.selectStyled).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "agent:main:alpha" })],
      }),
    );
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        boundGateway: resolvedConnection,
        session: "agent:main:alpha",
      }),
    );
  });

  it("resolves the resume connection once and hands it to the TUI as bound", async () => {
    createGatewayClient([session]);

    await runResumeCommand("agent:main:alpha", { url: "wss://gateway.example/control" });

    expect(mocks.connect).toHaveBeenCalledWith({
      url: "wss://gateway.example/control",
    });
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        boundGateway: resolvedConnection,
        session: "agent:main:alpha",
      }),
    );
  });

  it("rejects a non-interactive queried resume before connecting or launching the TUI", async () => {
    tty.set(false);

    await expect(runResumeCommand("global", {})).rejects.toThrow(
      "Attaching to a session requires an interactive terminal. Re-run `openclaw resume [query]` from an interactive terminal.",
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });
  it("closes the pre-TUI client when the command is interrupted", async () => {
    const client = createGatewayClient([]);
    let rejectResolve: (error: Error) => void = () => {};
    client.resolveSession.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectResolve = reject;
        }),
    );
    client.stop.mockImplementation(async () => {
      rejectResolve(new Error("Gateway connection closed"));
    });

    const pending = runResumeCommand(undefined, { handoff: createHandoff() });
    await vi.waitFor(() => expect(client.resolveSession).toHaveBeenCalledOnce());
    await waitForSignalExitBarriers("SIGINT");

    expect(client.stop).toHaveBeenCalled();
    await expect(pending).rejects.toThrow();
  });
});

describe("resume command registration", () => {
  it("preserves the reported session miss through an exiting runtime", async () => {
    const client = createGatewayClient([]);
    const exit = new ExitError(1);
    mocks.exit.mockImplementation(() => {
      throw exit;
    });
    const program = new Command().name("openclaw");
    registerResumeCli(program);
    await expect(program.parseAsync(["resume", "missing"], { from: "user" })).rejects.toBe(exit);
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.error.mock.calls).toEqual([
      ['No recent session matched "missing".'],
      [
        "Run `openclaw resume` to choose from recent sessions or `openclaw sessions` to inspect all sessions.",
      ],
    ]);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(mocks.runTui).not.toHaveBeenCalled();
  });
});

describe("real Gateway session boundary", () => {
  let harness: Awaited<ReturnType<typeof startMinimalRealGateway>>;
  let closeHarness: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    harness = await startMinimalRealGateway({
      sessions: [
        { agentId: "work", key: "agent:work:global", visibility: "shared" },
        { agentId: "main", key: "agent:main:alpha" },
      ],
      registerCleanup: (cleanup) => {
        closeHarness = cleanup;
      },
    });
  });

  afterAll(() => closeHarness?.());

  it("preserves an agent-qualified global session through the TUI handoff", async () => {
    const { GatewayChatClient } =
      await vi.importActual<typeof import("../tui/gateway-chat.js")>("../tui/gateway-chat.js");
    mocks.connect.mockImplementation((options) => GatewayChatClient.connect(options));
    await runResumeCommand("agent:work:global", { url: harness.url, token: harness.token });

    expect(harness.sessionListRequests).toContainEqual(
      expect.objectContaining({ agentId: "work", includeGlobal: true }),
    );
    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({ session: "agent:work:global" }),
    );
  });

  it("preserves real handoff wire outcomes and closes each client before returning", async () => {
    const { GatewayChatClient } =
      await vi.importActual<typeof import("../tui/gateway-chat.js")>("../tui/gateway-chat.js");
    const lifecycle: string[] = [];
    const resolveStart = harness.sessionResolveRequests.length;
    const listStart = harness.sessionListRequests.length;
    mocks.connect.mockImplementation(async (options) => {
      const client = await GatewayChatClient.connect(options);
      const stop = client.stop.bind(client);
      vi.spyOn(client, "stop").mockImplementation(async () => {
        await stop();
        lifecycle.push("stopped");
      });
      return client;
    });
    mocks.runTui.mockImplementation(async () => {
      lifecycle.push("tui");
    });
    const cases = [
      { key: "Agent:Main:ALPHA", agentId: "main", found: true },
      { key: "agent:main:resume-missing", agentId: "main", found: false },
      {
        key: "agent:resume-unconfigured:missing",
        agentId: "resume-unconfigured",
        found: false,
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const handoff = encodeResumeHandoff({ sessionKey: scenario.key, gatewayUrl: harness.url });
      const result = runResumeCommand(undefined, { handoff, token: harness.token });
      if (scenario.found) {
        await result;
      } else {
        await expect(result).rejects.toThrow(new Error(unresolvedHandoff));
      }
      expect(lifecycle.filter((event) => event === "stopped")).toHaveLength(index + 1);
    }

    expect(harness.sessionResolveRequests.slice(resolveStart)).toEqual(
      cases.map(({ key, agentId }) => ({ key, agentId, includeGlobal: true, allowMissing: true })),
    );
    expect(harness.sessionListRequests).toHaveLength(listStart);
    expect(mocks.runTui).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ session: "agent:main:alpha" }),
    );
    expect(lifecycle).toEqual(["stopped", "tui", "stopped", "stopped"]);
  });

  it("accepts a bootstrap-signed identity and rejects a mismatched signature", async () => {
    await expect(harness.connectBootstrap()).resolves.toMatchObject({ ok: true });
    expect(harness.hellos).toContainEqual(expect.objectContaining({ type: "hello-ok" }));

    await harness.connectBootstrap(true);
    expect(harness.connectFailures).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          code: ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID,
        }),
      }),
    );
  });
});
