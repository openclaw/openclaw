import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const defaultRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const createQuantdClientMock = vi.fn();
const snapshotMock = vi.fn();
const healthMock = vi.fn();

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../quantd/client.js", () => ({
  createQuantdClient: (...args: unknown[]) => createQuantdClientMock(...args),
  DEFAULT_QUANTD_BASE_URL: "http://127.0.0.1:19891",
}));

let registerQuantdCli: typeof import("./quantd-cli.js").registerQuantdCli;

beforeAll(async () => {
  ({ registerQuantdCli } = await import("./quantd-cli.js"));
});

beforeEach(() => {
  defaultRuntime.log.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.exit.mockClear();
  createQuantdClientMock.mockReset();
  snapshotMock.mockReset();
  healthMock.mockReset();
  createQuantdClientMock.mockReturnValue({
    snapshot: snapshotMock,
    health: healthMock,
  });
});

describe("quantd cli", () => {
  it("prints snapshot json", async () => {
    snapshotMock.mockResolvedValueOnce({
      health: { status: "ok", reasons: [] },
      replay: { lastSequence: 2 },
    });

    await runRegisteredCli({
      register: registerQuantdCli,
      argv: ["quantd", "snapshot", "--url", "http://127.0.0.1:19891"],
    });

    expect(createQuantdClientMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:19891",
      socketPath: undefined,
    });
    expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining('"lastSequence": 2'));
  });

  it("prints health summary", async () => {
    healthMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: "degraded",
    });

    await runRegisteredCli({
      register: registerQuantdCli,
      argv: ["quantd", "health", "--url", "http://127.0.0.1:19891"],
    });

    expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("degraded"));
  });
});
