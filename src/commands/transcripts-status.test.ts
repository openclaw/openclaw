import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMockCallOutput } from "../cli/test-runtime-capture.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { transcriptsStatusCommand } from "./transcripts-status.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

// mock-isolation: the shared gateway transport is replaced so no gateway is contacted.
vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    providers: [],
    configuredSources: [],
    active: [],
    latestTranscript: null,
    omitted: { providers: 0, configuredSources: 0, active: 0 },
    ...overrides,
  };
}

function provider(overrides: Record<string, unknown> = {}) {
  return { providerId: "claude", name: "Claude Code", availability: "enabled", ...overrides };
}

describe("transcriptsStatusCommand", () => {
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;

  const run = (opts: Parameters<typeof transcriptsStatusCommand>[0]) =>
    transcriptsStatusCommand(opts, runtime);
  const joinedArgs = (channel: "log" | "error") => getMockCallOutput(vi.mocked(runtime[channel]));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    runtime = createNonExitingRuntimeEnv();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("forwards empty params through the canonical RPC", async () => {
    mocks.callGateway.mockResolvedValueOnce(status());
    await run({});
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
      "transcripts.status",
      expect.any(Object),
      {},
      { defaultTimeoutMs: 30_000 },
    );
  });

  it("keeps the shared default deadline when no timeout is given", async () => {
    mocks.callGateway.mockResolvedValueOnce(status());
    await run({});
    const rpcOpts = mocks.callGateway.mock.calls[0]?.[1] ?? {};
    expect(rpcOpts).not.toHaveProperty("timeout");
  });

  it("emits the raw result envelope for --json", async () => {
    const payload = status({ enabled: true });
    mocks.callGateway.mockResolvedValueOnce(payload);
    await run({ json: true });
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("renders providers, configured sources, active captures, and latest transcript", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      status({
        enabled: true,
        providers: [provider()],
        configuredSources: [
          { source: { providerId: "manual" }, state: "not-active", title: "Notes" },
        ],
        active: [
          {
            selector: "2026-11-11/design-review",
            startedAt: "2026-11-11T10:00:00.000Z",
            title: "Design",
            activeSubscription: true,
          },
          {
            selector: "2026-11-11/cleanup-pending",
            startedAt: "2026-11-11T09:00:00.000Z",
            title: "Retained",
            activeSubscription: false,
          },
        ],
        latestTranscript: {
          selector: "2026-11-11/design-review",
          startedAt: "2026-11-11T10:00:00.000Z",
          title: "Design",
        },
      }),
    );
    await run({});
    const output = joinedArgs("log");
    expect(output).toContain("Transcript capture: enabled");
    expect(output).toContain("Providers (1):");
    expect(output).toContain("claude\tenabled\tClaude Code");
    expect(output).toContain("Configured sources (1):");
    expect(output).toContain("manual\tnot-active\tNotes");
    expect(output).toContain("Active captures (1):");
    expect(output).toContain("2026-11-11/design-review");
    expect(output).toContain("Retained captures (1):");
    expect(output).toContain("2026-11-11/cleanup-pending");
    expect(output).toContain("not subscribed");
    expect(output).toContain("Latest transcript: 2026-11-11/design-review");
  });

  it("reports an empty archive without failing", async () => {
    mocks.callGateway.mockResolvedValueOnce(status());
    await run({});
    expect(joinedArgs("log")).toContain("Transcript capture: disabled");
    expect(joinedArgs("log")).toContain(
      "No transcript providers, configured sources, or captures found.",
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("exits nonzero on a gateway failure", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway down"));
    await run({});
    expect(joinedArgs("error")).toContain("Failed to read transcript status");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("escapes terminal controls in text output", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      status({
        providers: [provider({ providerId: "cl\u0007aude", name: "Claude\u001b[2J\nCode" })],
        latestTranscript: {
          selector: "sel\u001b[2J",
          startedAt: "2026-11-11T10:00:00.000Z",
          title: "title\r\nx",
        },
      }),
    );
    await run({});
    const output = `${joinedArgs("log")}${joinedArgs("error")}`;
    for (const control of ["\u0007", "\u001b", "\r"]) {
      expect(output).not.toContain(control);
    }
  });
});
