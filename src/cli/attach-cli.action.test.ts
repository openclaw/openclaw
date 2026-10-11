import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsResolveResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) };
});

const spawnedChild = Object.assign(new EventEmitter(), { kill: vi.fn() });
let spawned = createDeferred();
let revokeStarted = createDeferred();
let revokeWork = async () => {};
let responseGate: { method: string; entered: () => void; release: Promise<void> } | undefined;
const configDirectories = new Set<string>();
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    configDirectories.add(dirname(args[2]!));
    spawned.resolve();
    return spawnedChild;
  }),
}));

const gatewayCalls: Array<{
  method: string;
  params: Record<string, unknown>;
  mode?: string;
  url?: string;
  token?: string;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: string[];
  hasDeviceIdentityKey: boolean;
}> = [];

function gatewayParams(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError("Expected gateway params to be an object");
  }
  return params as Record<string, unknown>;
}

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: vi.fn(
    async (p: {
      method: string;
      params: Record<string, unknown>;
      mode?: string;
      url?: string;
      token?: string;
      useStoredDeviceAuth?: boolean;
      requiredStoredDeviceAuthScopes?: string[];
    }) => {
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        url: p.url,
        token: p.token,
        useStoredDeviceAuth: p.useStoredDeviceAuth,
        requiredStoredDeviceAuthScopes: p.requiredStoredDeviceAuthScopes,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      if (responseGate?.method === p.method) {
        responseGate.entered();
        await responseGate.release;
      }
      if (p.method === "sessions.resolve") {
        return { ok: true, key: "agent:ops:thread:resolved" };
      }
      if (p.method === "agents.list") {
        return { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
      }
      if (p.method === "attach.grant") {
        const sessionKey = (p.params.sessionKey as string) ?? "agent:main:main";
        return {
          sessionKey,
          token: "tok-123",
          expiresAtMs: 2_000_000_000_000,
          mcpConfig: {
            mcpServers: {
              openclaw: {
                type: "http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
              },
            },
          },
          env: { OPENCLAW_MCP_TOKEN: "tok-123" },
        };
      }
      if (p.method === "attach.revoke") {
        revokeStarted.resolve();
        await revokeWork();
      }
      return {};
    },
  ),
  GatewayStoredDeviceAuthUnavailableError: class extends Error {},
  GatewayTransportError: class extends Error {},
}));

const logs: string[] = [];
let exitCode: number | undefined;
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: {
    log: (m: string) => logs.push(m),
    error: (m: string) => logs.push(`ERR:${m}`),
    exit: vi.fn((c: number) => {
      exitCode = c;
    }),
  },
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

import { callGateway } from "../gateway/call.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { registerAttachCli } from "./attach-cli.js";

const activeActions = new Set<Promise<void>>();
function runAttach(...args: string[]) {
  const action = (async () => {
    const program = new Command().name("openclaw").exitOverride();
    await registerAttachCli(program);
    await program.parseAsync(["node", "openclaw", "attach", ...args]);
  })();
  const settled = action.then(
    () => {},
    () => {},
  );
  activeActions.add(settled);
  void settled.then(() => activeActions.delete(settled));
  return action;
}
async function waitForSpawn(action: Promise<void>) {
  await awaitGateBeforeSettlement(
    spawned.promise,
    action,
    "attach returned before its child closed",
  );
}

describe("openclaw attach (action)", () => {
  beforeEach(() => {
    spawned = createDeferred();
    revokeStarted = createDeferred();
    revokeWork = async () => {};
    responseGate = undefined;
    vi.mocked(defaultRuntime.exit)
      .mockReset()
      .mockImplementation((code) => {
        exitCode = code;
      });
    gatewayCalls.length = 0;
    logs.length = 0;
    exitCode = undefined;
    spawnedChild.removeAllListeners();
    spawnedChild.kill.mockClear();
  });

  afterEach(async () => {
    revokeWork = async () => {};
    spawnedChild.emit("close", 0, null);
    await Promise.all(activeActions);
    const { spawn } = await import("node:child_process");
    for (const call of vi.mocked(spawn).mock.calls) {
      const args = call[1];
      if (Array.isArray(args) && typeof args[2] === "string") {
        configDirectories.add(dirname(args[2]));
      }
    }
    for (const line of logs) {
      if (line.startsWith("{")) {
        const parsed = JSON.parse(line) as { configPath?: string };
        if (parsed.configPath) {
          configDirectories.add(dirname(parsed.configPath));
        }
      }
    }
    for (const dir of configDirectories) {
      rmSync(dir, { recursive: true, force: true });
    }
    configDirectories.clear();
  });

  it.each([
    {
      name: "sanitized wide labels",
      labels: ["\u001b[31m界界界界界界\u001b[0m", "Alpha"],
      expectedLines: [
        "SESSION       ID PREFIX",
        "界界界界界界  123456780aaa4000",
        "Alpha         123456780bbb4000",
      ],
    },
    {
      name: "an emoji crossing the name limit",
      labels: ["A".repeat(39) + "😀", "Alpha"],
      expectedLines: [
        `SESSION${" ".repeat(35)}ID PREFIX`,
        `${"A".repeat(39)}…  123456780aaa4000`,
        `Alpha${" ".repeat(37)}123456780bbb4000`,
      ],
    },
  ])("renders ambiguous session candidates with $name", async ({ labels, expectedLines }) => {
    const response = {
      ok: false,
      candidates: [
        {
          key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
          agentId: "main",
          displayName: labels[0],
        },
        {
          key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
          agentId: "main",
          displayName: labels[1],
        },
      ],
    } satisfies SessionsResolveResult;
    const gateway = vi.mocked(callGateway);
    const originalImplementation = gateway.getMockImplementation();
    const { spawn } = await import("node:child_process");
    const spawnCount = vi.mocked(spawn).mock.calls.length;
    gateway.mockReset();
    // Any request after resolution must fail before a grant can reach config writing or spawn.
    gateway.mockRejectedValue(new Error("Unexpected Gateway request after session resolution"));
    gateway.mockResolvedValueOnce(response);
    try {
      const error = await runAttach("12345678").catch((caught: unknown) => caught);
      if (!(error instanceof Error)) {
        throw new Error("Expected ambiguous session target rejection");
      }
      expect(error.message).toBe(
        [
          "Session reference is ambiguous:",
          ...expectedLines,
          "Pass a longer reference. Run `openclaw sessions list` to choose a full session key.",
        ].join("\n"),
      );
      expect(Buffer.from(error.message, "utf8").toString("utf8")).toBe(error.message);
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(gateway).toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.resolve", params: { shortId: "12345678" } }),
      );
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCount);
    } finally {
      gateway.mockReset();
      if (originalImplementation) {
        gateway.mockImplementation(originalImplementation);
      }
    }
  });

  it("keeps the printed configuration after setup-only completion", async () => {
    await runAttach("--print-config", "--session", "agent:main:cli");
    const printed = JSON.parse(logs[0]!) as { configPath: string };
    expect(existsSync(printed.configPath)).toBe(true);
    expect(gatewayCalls.some((call) => call.method === "attach.revoke")).toBe(false);
  });

  it("resolves a URL target before granting on the same origin", async () => {
    await runAttach(
      "https://gateway.example/base/dashboard/ops/movies-a1166b81",
      "--token",
      "explicit-token",
      "--print-config",
    );

    const resolve = gatewayCalls.find((call) => call.method === "sessions.resolve");
    expect(resolve).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read"],
      params: { shortId: "a1166b81", slugHint: "movies" },
    });
    expect(gatewayCalls.find((call) => call.method === "attach.grant")).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.admin"],
      params: { sessionKey: "agent:ops:thread:resolved" },
      mode: "cli",
      hasDeviceIdentityKey: false,
    });
    expect(gatewayCalls.find((call) => call.method === "attach.revoke")).toBeUndefined();
  });

  it("preserves a global-scope URL main session when granting attach access", async () => {
    await runAttach(
      "https://gateway.example/base/dashboard/ops",
      "--token",
      "explicit-token",
      "--print-config",
    );

    expect(gatewayCalls.find((call) => call.method === "agents.list")).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read"],
      params: {},
    });
    expect(gatewayCalls.find((call) => call.method === "attach.grant")).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.admin"],
      params: { sessionKey: "global", agentId: "ops" },
    });
  });

  it.each(["agent:ops:main", "https://gateway.example/chat/stale/movies-a1166b81"])(
    "preserves the resolved global owner when attaching to %s",
    async (target) => {
      vi.mocked(callGateway).mockResolvedValueOnce({ ok: true, key: "global", agentId: "ops" });

      await runAttach(target, "--print-config");

      expect(gatewayCalls.find((call) => call.method === "attach.grant")?.params).toMatchObject({
        sessionKey: "global",
        agentId: "ops",
      });
    },
  );

  it.each(["1e3"])("rejects malformed --ttl %s before minting", async (ttl) => {
    await runAttach("--ttl", ttl, "--print-config");
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--ttl must be a positive integer of milliseconds");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it.each([
    { code: 7, signal: null, expected: 7 },
    { code: null, signal: "SIGTERM", expected: 143 },
  ] as const)(
    "joins child close and revoke before unwinding with $expected",
    async ({ code, signal, expected }) => {
      const allowRevoke = createDeferred();
      revokeWork = () => allowRevoke.promise;
      vi.mocked(defaultRuntime.exit).mockImplementation((value) => {
        throw new ExitError(value);
      });
      const beforeInt = process.listeners("SIGINT");
      const beforeTerm = process.listeners("SIGTERM");
      const action = runAttach("--session", "agent:main:spawn");
      const outcome = action.catch((error: unknown) => error);
      await waitForSpawn(action);
      const { spawn } = await import("node:child_process");
      const args = vi.mocked(spawn).mock.calls.at(-1)?.[1];
      expect(args).toEqual([
        "--strict-mcp-config",
        "--mcp-config",
        expect.stringContaining(".mcp.json"),
      ]);
      const configPath = Array.isArray(args) ? args[2] : undefined;
      if (typeof configPath !== "string") {
        throw new Error("missing spawned MCP config path");
      }
      expect(existsSync(configPath)).toBe(true);
      const onSigint = process.listeners("SIGINT").find((fn) => !beforeInt.includes(fn));
      const onSigterm = process.listeners("SIGTERM").find((fn) => !beforeTerm.includes(fn));
      expect(onSigint).toBeTypeOf("function");
      onSigint?.("SIGINT");
      expect(spawnedChild.kill).not.toHaveBeenCalled();
      onSigterm?.("SIGTERM");
      expect(spawnedChild.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      spawnedChild.emit("exit", code, signal);
      expect(gatewayCalls.some((call) => call.method === "attach.revoke")).toBe(false);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      spawnedChild.emit("close", code, signal);
      try {
        await awaitGateBeforeSettlement(
          revokeStarted.promise,
          action,
          "attach skipped grant revocation",
        );
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        expect(existsSync(configPath)).toBe(true);
      } finally {
        allowRevoke.resolve();
      }
      expect(await outcome).toEqual(new ExitError(expected));
      expect(gatewayCalls.filter((call) => call.method === "attach.revoke")).toHaveLength(1);
      expect(existsSync(configPath)).toBe(false);
      expect(process.listeners("SIGINT")).toEqual(beforeInt);
      expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
    },
  );

  it("revokes once and surfaces a launch failure when the child errors", async () => {
    const exit = new ExitError(1);
    vi.mocked(defaultRuntime.exit).mockImplementation((code) => {
      exitCode = code;
      throw exit;
    });
    const action = runAttach("--session", "agent:main:spawn-err");
    const completed = expect(action).rejects.toBe(exit);
    await waitForSpawn(action);
    spawnedChild.emit("error", new Error("ENOENT"));
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    spawnedChild.emit("close", -2, null);
    await completed;
    expect(gatewayCalls.filter((c) => c.method === "attach.revoke")).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Failed to launch");
  });

  it.each(["sessions.resolve", "attach.grant"] as const)(
    "fences attach side effects when cancellation wins the %s response",
    async (method) => {
      const scope = new AsyncWorkScope();
      const entered = createDeferred();
      const release = createDeferred();
      const cancelled = new Error("attach command cancelled");
      responseGate = { method, entered: entered.resolve, release: release.promise };
      const { spawn } = await import("node:child_process");
      const spawnCount = vi.mocked(spawn).mock.calls.length;
      const configCount = vi.mocked(mkdtempSync).mock.calls.length;
      const action = scope.track(() =>
        method === "sessions.resolve"
          ? runAttach("movies-a1166b81")
          : runAttach("--session", "agent:main:late-grant"),
      );
      const outcome = action.then(
        () => ({ status: "completed" }),
        (error: unknown) => ({ status: "cancelled", error }),
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          action,
          "attach did not reach the held response",
        );
        scope.beginClose(cancelled);
        release.resolve();
        // A regressed action waits on its new child forever. Observe admission
        // directly so the test fails promptly and can still close that child.
        await expect(
          Promise.race([outcome, spawned.promise.then(() => ({ status: "spawned" }))]),
        ).resolves.toEqual({ status: "cancelled", error: cancelled });
        expect(vi.mocked(spawn).mock.calls).toHaveLength(spawnCount);
        expect(vi.mocked(mkdtempSync).mock.calls).toHaveLength(configCount);
        expect(gatewayCalls.filter((call) => call.method === "attach.grant")).toHaveLength(
          method === "attach.grant" ? 1 : 0,
        );
        const revocations = gatewayCalls.filter((call) => call.method === "attach.revoke");
        expect(revocations).toHaveLength(method === "attach.grant" ? 1 : 0);
        if (method === "attach.grant") {
          expect(revocations[0]?.params).toEqual({ token: "tok-123" });
        }
      } finally {
        release.resolve();
        spawnedChild.emit("close", 0, null);
        await outcome;
        await scope.drain();
        responseGate = undefined;
      }
    },
  );

  it("revokes the minted grant if spawning throws synchronously", async () => {
    const { spawn } = await import("node:child_process");
    const failure = new Error("spawn rejected");
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(runAttach("--session", "agent:main:spawn")).rejects.toBe(failure);
    expect(gatewayCalls.map((call) => call.method)).toEqual(["attach.grant", "attach.revoke"]);
  });

  it("warns when revoke fails but still exits with the child status", async () => {
    vi.mocked(callGateway).mockImplementationOnce(async (p) => {
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      return {
        sessionKey: "agent:main:spawn",
        token: "tok-123",
        expiresAtMs: 2_000_000_000_000,
        mcpConfig: { mcpServers: { openclaw: {} } },
        env: { OPENCLAW_MCP_TOKEN: "tok-123" },
      } as never;
    });
    vi.mocked(callGateway).mockImplementationOnce(async (p) => {
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      throw new Error("gateway down");
    });

    const action = runAttach("--session", "agent:main:spawn");
    await waitForSpawn(action);
    spawnedChild.emit("exit", 0, null);
    spawnedChild.emit("close", 0, null);
    await action;

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("failed to revoke attach grant");
  });

  it("errors on a grant with a non-numeric expiresAtMs instead of crashing on toISOString", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({
      sessionKey: "agent:main:x",
      token: "tok-123",
      expiresAtMs: "soon",
      mcpConfig: { mcpServers: { openclaw: {} } },
      env: {},
    } as never);
    await runAttach("--print-config");
    expect(exitCode).toBe(1);
  });
});
