import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: async (
    _opts: { label: string; indeterminate: boolean; enabled: boolean },
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import { sessionsLabelCommand } from "./sessions-label.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[]; errors: string[]; exits: number[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => errors.push(String(msg)),
      exit: (code?: number) => exits.push(code ?? 0),
    },
    logs,
    errors,
    exits,
  };
}

describe("sessionsLabelCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing session", async () => {
    const { runtime, errors, exits } = makeRuntime();
    await sessionsLabelCommand({ session: "", label: "x" }, runtime);
    expect(errors.some((e) => e.includes("--session"))).toBe(true);
    expect(exits).toContain(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("rejects clear plus label", async () => {
    const { runtime, errors, exits } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:main", label: "x", clear: true }, runtime);
    expect(errors.some((e) => e.includes("clear"))).toBe(true);
    expect(exits).toContain(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("rejects missing label when not clearing", async () => {
    const { runtime, errors, exits } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:main" }, runtime);
    expect(errors.some((e) => e.includes("label"))).toBe(true);
    expect(exits).toContain(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("calls sessions.patch with label", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true, key: "agent:main:main" });
    mocks.callGateway.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:main",
      path: "/p",
      entry: { label: "Morning digest", sessionId: "s", updatedAt: 1 },
    });
    const { runtime, logs } = makeRuntime();
    await sessionsLabelCommand(
      { session: "agent:main:main", label: "Morning digest", timeout: 5000 },
      runtime,
    );
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "sessions.patch",
        params: { key: "agent:main:main", label: "Morning digest" },
        timeoutMs: 5000,
      }),
    );
    expect(logs.some((l) => l.includes("Set label") && l.includes("Morning digest"))).toBe(true);
  });

  it("calls sessions.patch with null label when clearing", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true, key: "agent:main:main" });
    mocks.callGateway.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:main",
      path: "/p",
      entry: { sessionId: "s", updatedAt: 1 },
    });
    const { runtime, logs } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:main", clear: true }, runtime);
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: { key: "agent:main:main", label: null },
      }),
    );
    expect(logs.some((l) => l.includes("Cleared label"))).toBe(true);
  });

  it("logs set label even if gateway response omits entry.label", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true, key: "agent:main:main" });
    mocks.callGateway.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:main",
      path: "/p",
      entry: { sessionId: "s", updatedAt: 1 },
    });
    const { runtime, logs } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:main", label: "Morning digest" }, runtime);
    expect(logs.some((l) => l.includes("Set label") && l.includes("Morning digest"))).toBe(true);
  });

  it("writes JSON when --json", async () => {
    const payload = {
      ok: true as const,
      key: "agent:main:main",
      path: "/p",
      entry: { label: "x", sessionId: "s", updatedAt: 1 },
    };
    mocks.callGateway
      .mockResolvedValueOnce({ ok: true, key: "agent:main:main" })
      .mockResolvedValueOnce(payload);
    const logs: string[] = [];
    const runtime: RuntimeEnv = {
      log: (msg: unknown) => logs.push(String(msg)),
      error: () => {},
      exit: () => {},
    };
    await sessionsLabelCommand({ session: "agent:main:main", label: "x", json: true }, runtime);
    expect(mocks.callGateway).toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual(payload);
  });

  it("rejects unknown session keys unless forced", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("No session found: agent:main:maan"));
    const { runtime, errors, exits } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:maan", label: "x", timeout: 5000 }, runtime);
    expect(errors.some((e) => e.toLowerCase().includes("unknown session key"))).toBe(true);
    expect(exits).toContain(1);
    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.resolve" }),
    );
  });

  it("surfaces preflight gateway errors instead of rewriting them as unknown session key", async () => {
    mocks.callGateway.mockRejectedValueOnce(
      new Error("gateway timeout after 5000ms\nconnection details"),
    );
    const { runtime, errors, exits } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:main", label: "x" }, runtime);
    expect(errors.some((e) => e.includes("gateway timeout"))).toBe(true);
    expect(errors.some((e) => e.toLowerCase().includes("unknown session key"))).toBe(false);
    expect(exits).toContain(1);
    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  });

  it("preflights with sessions.resolve so aliases match patch canonicalization", async () => {
    mocks.callGateway
      .mockResolvedValueOnce({ ok: true, key: "agent:main:main" })
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:main",
        path: "/p",
        entry: { label: "Hi", sessionId: "s", updatedAt: 1 },
      });
    const { runtime, logs } = makeRuntime();
    await sessionsLabelCommand({ session: "main", label: "Hi" }, runtime);
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "sessions.resolve",
        params: {
          key: "main",
          includeGlobal: true,
          includeUnknown: true,
        },
      }),
    );
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "sessions.patch",
        params: { key: "main", label: "Hi" },
      }),
    );
    expect(logs.some((l) => l.includes("Set label") && l.includes("Hi"))).toBe(true);
  });

  it("allows unknown session keys when forced", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:maan",
      path: "/p",
      entry: { label: "x", sessionId: "s", updatedAt: 1 },
    });
    const { runtime, logs } = makeRuntime();
    await sessionsLabelCommand({ session: "agent:main:maan", label: "x", force: true }, runtime);
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.patch" }),
    );
    expect(logs.some((l) => l.includes("Set label"))).toBe(true);
  });
});
