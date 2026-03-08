import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStatusCommand } from "./status.js";

const callGatewayMock = vi.fn();
const withProgressMock = vi.fn(
  async (_opts: unknown, action: () => Promise<unknown>) => await action(),
);

vi.mock("../../gateway/call.js", () => ({
  callGateway: (options: { method: string; params: unknown; timeoutMs: number }) =>
    callGatewayMock(options),
}));

vi.mock("../../cli/progress.js", () => ({
  withProgress: (opts: unknown, action: () => Promise<unknown>) => withProgressMock(opts, action),
}));

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
  };
  return { runtime, logs, errors };
}

describe("channelsStatusCommand timeout validation", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    withProgressMock.mockClear();
  });

  it("exits with clear error for non-numeric timeout", async () => {
    const { runtime, errors } = createRuntime();
    await expect(channelsStatusCommand({ timeout: "nope" }, runtime)).rejects.toThrow("exit:1");
    expect(errors).toContain("--timeout must be a positive integer (milliseconds)");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("exits with clear error for zero timeout", async () => {
    const { runtime, errors } = createRuntime();
    await expect(channelsStatusCommand({ timeout: "0" }, runtime)).rejects.toThrow("exit:1");
    expect(errors).toContain("--timeout must be a positive integer (milliseconds)");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("exits with clear error for negative timeout", async () => {
    const { runtime, errors } = createRuntime();
    await expect(channelsStatusCommand({ timeout: "-1" }, runtime)).rejects.toThrow("exit:1");
    expect(errors).toContain("--timeout must be a positive integer (milliseconds)");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("exits with clear error for decimal timeout", async () => {
    const { runtime, errors } = createRuntime();
    await expect(channelsStatusCommand({ timeout: "1.5" }, runtime)).rejects.toThrow("exit:1");
    expect(errors).toContain("--timeout must be a positive integer (milliseconds)");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("exits with clear error for empty or whitespace-only timeout", async () => {
    const { runtime, errors } = createRuntime();
    await expect(channelsStatusCommand({ timeout: "" }, runtime)).rejects.toThrow("exit:1");
    expect(errors).toContain("--timeout must be a positive integer (milliseconds)");
    expect(callGatewayMock).not.toHaveBeenCalled();
    const { runtime: r2, errors: e2 } = createRuntime();
    await expect(channelsStatusCommand({ timeout: "  " }, r2)).rejects.toThrow("exit:1");
    expect(e2).toContain("--timeout must be a positive integer (milliseconds)");
  });

  it("passes validated timeout to gateway call", async () => {
    const { runtime } = createRuntime();
    callGatewayMock.mockResolvedValueOnce({});
    await channelsStatusCommand({ timeout: "2500", json: true }, runtime);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "channels.status",
      params: { probe: false, timeoutMs: 2500 },
      timeoutMs: 2500,
    });
  });
});
