import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  resolveDefaultSessionStorePath: vi.fn(),
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
}));

vi.mock("../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveDefaultSessionStorePath: mocks.resolveDefaultSessionStorePath,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("exportTrajectoryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDefaultSessionStorePath.mockReturnValue("/tmp/openclaw/sessions.json");
    mocks.loadSessionStore.mockReturnValue({});
  });

  it("points missing session key users at the sessions command", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports malformed encoded request JSON without leaking parser output", async () => {
    const runtime = createRuntime();
    const requestJsonBase64 = Buffer.from("not json", "utf8").toString("base64url");

    await exportTrajectoryCommand({ requestJsonBase64 }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to decode trajectory export request: Encoded trajectory export request is invalid JSON",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("points missing session users at the sessions command", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves direct sessionKey when encoded request omits it (#83282)", async () => {
    // Encoded request only supplies `output`, no sessionKey. The previous
    // decode shape returned `sessionKey: ""`, which overwrote the direct
    // --session-key from opts and tripped the "missing" path.
    const runtime = createRuntime();
    const requestJsonBase64 = Buffer.from(
      JSON.stringify({ output: "/tmp/trajectory.json" }),
      "utf8",
    ).toString("base64url");

    await exportTrajectoryCommand(
      {
        sessionKey: "agent:main:telegram:direct:456",
        requestJsonBase64,
      },
      runtime,
    );

    // The direct sessionKey survived the merge: failure must be
    // "Session not found" (because the store is empty), NOT
    // "--session-key is required" (which is the pre-fix bug surface).
    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:456. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.error).not.toHaveBeenCalledWith(
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("lets encoded sessionKey override when direct sessionKey is not given (#83282)", async () => {
    // Reverse case: when only the encoded request supplies sessionKey, the
    // resolved options must pick it up.
    const runtime = createRuntime();
    const requestJsonBase64 = Buffer.from(
      JSON.stringify({ sessionKey: "agent:main:telegram:direct:789" }),
      "utf8",
    ).toString("base64url");

    await exportTrajectoryCommand({ requestJsonBase64 }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:789. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
