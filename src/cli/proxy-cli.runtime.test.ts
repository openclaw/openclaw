// Proxy CLI runtime tests cover proxy runtime process handling and lifecycle events.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const { getRuntimeConfigMock, runProxyValidationMock, serverStopSpy, spawnMock } = vi.hoisted(
  () => ({
    getRuntimeConfigMock: vi.fn(),
    runProxyValidationMock: vi.fn(),
    serverStopSpy: vi.fn(async () => undefined),
    spawnMock: vi.fn(),
  }),
);

vi.mock("../process/exec-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec-spawn.js")>();
  return {
    ...actual,
    spawnCommand: spawnMock,
  };
});

vi.mock("../proxy-capture/proxy-server.js", () => ({
  startDebugProxyServer: vi.fn(async () => ({
    proxyUrl: "http://127.0.0.1:7799",
    stop: serverStopSpy,
  })),
}));

// mock-isolation: Proxy runtime fixtures control config without preparing a real config owner.
vi.mock("../config/config.js", () => ({
  loadConfig: getRuntimeConfigMock,
  getRuntimeConfig: getRuntimeConfigMock,
  captureRuntimeConfigAsyncReader: () => async () => getRuntimeConfigMock(),
}));

vi.mock("../infra/net/proxy/proxy-validation.js", () => ({
  runProxyValidation: runProxyValidationMock,
}));

vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  return {
    ...actual,
    isRich: () => false,
  };
});

import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import type { CaptureEventKind } from "../proxy-capture/types.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { registerProxyCli } from "./proxy-cli.js";
import * as proxyCliRuntime from "./proxy-cli.runtime.js";

describe("proxy cli runtime", () => {
  const envKeys = [
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_DEBUG_PROXY_CERT_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "FORCE_COLOR",
    "NO_COLOR",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const tempDirs = new Set<string>();
  const tempDir = makeTempDir(tempDirs, "openclaw-proxy-cli-runtime-");
  const stdoutWrite = vi.fn<typeof process.stdout.write>(() => true);

  beforeEach(() => {
    // Reuse the path so missing store/DB cleanup is observable as sessions leaking across cases.
    mkdirSync(tempDir, { recursive: true });
    tempDirs.add(tempDir);
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_DEBUG_PROXY_CERT_DIR = path.join(tempDir, "certs");
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID;
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({
      proxy: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
      },
    });
    runProxyValidationMock.mockReset();
    runProxyValidationMock.mockResolvedValue({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [
        {
          kind: "allowed",
          url: "https://example.com/",
          ok: true,
          status: 200,
        },
      ],
    });
    process.exitCode = undefined;
    stdoutWrite.mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutWrite);
    serverStopSpy.mockClear();
    spawnMock.mockReset();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    cleanupTempDirs(tempDirs);
  });

  async function seedQueryEvents(kind: CaptureEventKind) {
    const lease = await acquireDebugProxyCaptureStoreAsync();
    try {
      for (const sessionId of ["selected", "unrelated"]) {
        await lease.store.upsertSession({
          id: sessionId,
          startedAt: 1,
          mode: "test",
          sourceScope: "openclaw",
          sourceProcess: "test",
        });
        for (const ts of [1, 2]) {
          await lease.store.recordEvent({
            sessionId,
            ts,
            sourceScope: "openclaw",
            sourceProcess: "test",
            protocol: kind === "ws-frame" ? "wss" : "https",
            direction: "outbound",
            kind,
            flowId: "query-flow",
            host: "synthetic.invalid",
            path: "/events?cursor=1",
            method: "POST",
            status: 429,
            dataSha256: "same-payload",
          });
        }
      }
    } finally {
      await lease.release();
    }
  }

  function createQueryProgram() {
    const writeErr = vi.fn();
    const program = new Command().exitOverride().configureOutput({ writeErr });
    registerProxyCli(program);
    return { program, writeErr };
  }

  it.each([
    { preset: "double-sends", kind: "request", countKey: "duplicateCount" },
    { preset: "retry-storms", kind: "response", countKey: "errorCount" },
    { preset: "cache-busting", kind: "request", countKey: "variantCount" },
    { preset: "ws-duplicate-frames", kind: "ws-frame", countKey: "duplicateFrames" },
    { preset: "missing-ack", kind: "ws-frame", countKey: "outboundFrames" },
    { preset: "error-bursts", kind: "error", countKey: "errorCount" },
  ] as const)("runs registered preset $preset against only the selected capture", async (entry) => {
    await seedQueryEvents(entry.kind);
    const { program } = createQueryProgram();
    await program.parseAsync(
      ["proxy", "query", "--preset", entry.preset, "--session", "selected", "--json"],
      { from: "user" },
    );
    const output = String(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(output)).toEqual({
      rows: [expect.objectContaining({ host: "synthetic.invalid", [entry.countKey]: 2 })],
    });
    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([
    { preset: "error-burst", json: false },
    { preset: "error-burst", json: true },
    { preset: "", json: false },
    { preset: "", json: true },
  ])("rejects invalid registered preset $preset (json: $json)", async ({ preset, json }) => {
    await seedQueryEvents("error");
    const { program, writeErr } = createQueryProgram();
    await expect(
      program.parseAsync(["proxy", "query", "--preset", preset, ...(json ? ["--json"] : [])], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "commander.invalidArgument", exitCode: 1 });
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("Allowed choices are"));
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("error-bursts"));
  });

  it("prints proxy validation text and leaves exit code unset on success", async () => {
    await proxyCliRuntime.runProxyValidateCommand({
      proxyUrl: "http://override.example:3128",
      proxyCaFile: "./ca.pem",
      allowedUrls: ["https://allowed.example/"],
      deniedUrls: ["http://127.0.0.1/"],
      apnsReachability: true,
      apnsAuthority: "https://api.sandbox.push.apple.com",
      timeoutMs: 1234,
    });

    expect(getRuntimeConfigMock).toHaveBeenCalledOnce();
    expect(runProxyValidationMock).toHaveBeenCalledWith({
      config: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
      },
      env: process.env,
      proxyUrlOverride: "http://override.example:3128",
      proxyCaFileOverride: "./ca.pem",
      allowedUrls: ["https://allowed.example/"],
      deniedUrls: ["http://127.0.0.1/"],
      apnsReachability: true,
      apnsAuthority: "https://api.sandbox.push.apple.com",
      timeoutMs: 1234,
    });
    expect(process.stdout["write"]).toHaveBeenCalledWith(
      "Proxy validation passed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://config-proxy.example:3128/\n\n" +
        "Checks\n" +
        "  ✓ allowed https://example.com/ HTTP 200\n",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("redacts proxy credentials in text output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@proxy.example:3128?token=secret#fragment",
        source: "config",
        errors: [],
      },
      checks: [],
    });
    await proxyCliRuntime.runProxyValidateCommand({});

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      "Proxy validation passed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://redacted:redacted@proxy.example:3128/\n",
    );
  });

  it("redacts proxy credentials in JSON output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@proxy.example:3128?token=secret#fragment",
        source: "config",
        errors: [],
      },
      checks: [],
    });
    await proxyCliRuntime.runProxyValidateCommand({ json: true });

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          ok: true,
          config: {
            enabled: true,
            proxyUrl: "http://redacted:redacted@proxy.example:3128/",
            source: "config",
            errors: [],
          },
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("prints actionable output when proxy config is disabled and missing", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: false,
        source: "disabled",
        errors: [
          "proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url",
        ],
      },
      checks: [],
    });
    await proxyCliRuntime.runProxyValidateCommand({});

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: disabled\n" +
        "  URL:    not configured\n\n" +
        "Problems\n" +
        "  - proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url\n\n" +
        "Next steps\n" +
        "  Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// or https:// proxy.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints CA-file guidance when proxy CA files cannot be read", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        proxyUrl: "https://proxy.example:8443",
        source: "config",
        errors: ["proxy CA file could not be read (/missing/ca.pem): ENOENT"],
      },
      checks: [],
    });
    await proxyCliRuntime.runProxyValidateCommand({});

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    https://proxy.example:8443/\n\n" +
        "Problems\n" +
        "  - proxy CA file could not be read (/missing/ca.pem): ENOENT\n\n" +
        "Next steps\n" +
        "  Confirm proxy.tls.caFile or --proxy-ca-file points to a readable PEM CA file for the HTTPS proxy endpoint.\n",
    );
  });

  it("redacts malformed proxy URLs in JSON output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@",
        source: "override",
        errors: ["proxyUrl must use http://"],
      },
      checks: [],
    });
    await proxyCliRuntime.runProxyValidateCommand({ json: true });

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          ok: false,
          config: {
            enabled: true,
            proxyUrl: "<invalid proxy URL>",
            source: "override",
            errors: ["proxyUrl must use http://"],
          },
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("prints check errors on the same line", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [
        {
          kind: "denied",
          url: "http://127.0.0.1:12345/",
          ok: true,
          error: "fetch failed",
        },
      ],
    });
    await proxyCliRuntime.runProxyValidateCommand({});

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      "Proxy validation passed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://proxy.example:3128/\n\n" +
        "Checks\n" +
        "  ✓ denied  http://127.0.0.1:12345/ — fetch failed\n",
    );
  });

  it("prints actionable check failure output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        proxyUrl: "http://proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [
        {
          kind: "allowed",
          url: "http://target.example/allowed",
          ok: true,
          status: 200,
        },
        {
          kind: "denied",
          url: "http://target.example/allowed",
          ok: false,
          status: 200,
          error: "Denied destination was reachable through the proxy",
        },
      ],
    });
    await proxyCliRuntime.runProxyValidateCommand({});

    expect(process.stdout["write"]).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://proxy.example:3128/\n\n" +
        "Checks\n" +
        "  ✓ allowed http://target.example/allowed HTTP 200\n" +
        "  ✗ denied  http://target.example/allowed HTTP 200 — Denied destination was reachable through the proxy\n\n" +
        "Next steps\n" +
        "  Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([{ signal: "SIGTERM" as const, exitCode: 143 }])(
    "preserves exit code $exitCode when the proxied child exits from $signal",
    async (testCase) => {
      spawnMock.mockResolvedValue({ signal: testCase.signal, failed: true });

      await proxyCliRuntime.runDebugProxyRunCommand({ commandArgs: ["example-command"] });

      expect(process.exitCode).toBe(testCase.exitCode);
      expect(serverStopSpy).toHaveBeenCalledOnce();
    },
  );

  it("stops the proxy server and ends the session when child spawn fails", async () => {
    spawnMock.mockRejectedValue(new Error("spawn failed"));

    const beforeRun = Date.now();
    await expect(
      proxyCliRuntime.runDebugProxyRunCommand({
        commandArgs: ["does-not-exist"],
      }),
    ).rejects.toThrow("spawn failed");

    expect(serverStopSpy).toHaveBeenCalledTimes(1);

    const lease = await acquireDebugProxyCaptureStoreAsync();
    try {
      const [session] = await lease.store.listSessions(5);
      expect(session?.mode).toBe("proxy-run");
      expect(session?.endedAt).toBeGreaterThanOrEqual(beforeRun);
    } finally {
      await lease.release();
    }
  });

  it.each([
    {
      name: "coverage",
      run: async (runtime: typeof import("./proxy-cli.runtime.js")) =>
        await runtime.runDebugProxyCoverageCommand(),
      assertShape: (value: unknown) =>
        expect(value).toEqual({
          summary: expect.objectContaining({ total: expect.any(Number) }),
          entries: expect.any(Array),
        }),
    },
    {
      name: "sessions",
      run: async (runtime: typeof import("./proxy-cli.runtime.js")) =>
        await runtime.runDebugProxySessionsCommand({ json: true }),
      assertShape: (value: unknown) => expect(value).toEqual({ sessions: [] }),
    },
    {
      name: "query",
      run: async (runtime: typeof import("./proxy-cli.runtime.js")) =>
        await runtime.runDebugProxyQueryCommand({ json: true, preset: "double-sends" }),
      assertShape: (value: unknown) => expect(value).toEqual({ rows: [] }),
    },
  ])("prints one undecorated JSON object for proxy $name --json", async ({ run, assertShape }) => {
    await run(proxyCliRuntime);

    expect(process.stdout["write"]).toHaveBeenCalledOnce();
    const output = String(vi.mocked(process.stdout["write"]).mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(output) as unknown;
    assertShape(parsed);
  });

  it.each([
    {
      name: "sessions",
      run: async (runtime: typeof import("./proxy-cli.runtime.js")) =>
        await runtime.runDebugProxySessionsCommand({}),
    },
    {
      name: "query",
      run: async (runtime: typeof import("./proxy-cli.runtime.js")) =>
        await runtime.runDebugProxyQueryCommand({ preset: "double-sends" }),
    },
  ])("preserves the legacy bare-array proxy $name output without --json", async ({ run }) => {
    await run(proxyCliRuntime);

    const output = String(vi.mocked(process.stdout["write"]).mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(output)).toEqual([]);
  });
});
