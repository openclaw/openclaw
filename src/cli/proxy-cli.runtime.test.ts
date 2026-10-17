import { mkdirSync } from "node:fs";
import path from "node:path";
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

import type { ProxyValidationResult } from "../infra/net/proxy/proxy-validation.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import * as proxyCliRuntime from "./proxy-cli.runtime.js";

const proxyConfig = { enabled: true, proxyUrl: "http://config-proxy.example:3128" };
async function validate(
  config: Partial<ProxyValidationResult["config"]>,
  {
    checks = [],
    ok = true,
    json = false,
  }: {
    checks?: ProxyValidationResult["checks"];
    ok?: boolean;
    json?: boolean;
  } = {},
) {
  runProxyValidationMock.mockResolvedValueOnce({
    ok,
    config: { ...proxyConfig, source: "config", errors: [], ...config },
    checks,
  });
  await proxyCliRuntime.runProxyValidateCommand({ json });
}
function expectValidationText(url: string, suffix = "", ok = true, source = "config") {
  expect(process.stdout.write).toHaveBeenCalledWith(
    `Proxy validation ${ok ? "passed" : "failed"}\n\nProxy\n  Source: ${source}\n  URL:    ${url}\n${suffix}`,
  );
}
function readOutput(): unknown {
  return JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0] ?? ""));
}

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
    getRuntimeConfigMock.mockReturnValue({ proxy: proxyConfig });
    runProxyValidationMock.mockReset();
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
    await validate({
      proxyUrl: "http://user:secret@proxy.example:3128?token=secret#fragment",
    });

    expectValidationText("http://redacted:redacted@proxy.example:3128/");
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
    await validate(
      {
        enabled: false,
        proxyUrl: undefined,
        source: "disabled",
        errors: [
          "proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url",
        ],
      },
      { ok: false },
    );

    expectValidationText(
      "not configured",
      "\nProblems\n" +
        "  - proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url\n\n" +
        "Next steps\n" +
        "  Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// or https:// proxy.\n",
      false,
      "disabled",
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints CA-file guidance when proxy CA files cannot be read", async () => {
    await validate(
      {
        proxyUrl: "https://proxy.example:8443",
        errors: ["proxy CA file could not be read (/missing/ca.pem): ENOENT"],
      },
      { ok: false },
    );

    expectValidationText(
      "https://proxy.example:8443/",
      "\nProblems\n" +
        "  - proxy CA file could not be read (/missing/ca.pem): ENOENT\n\n" +
        "Next steps\n" +
        "  Confirm proxy.tls.caFile or --proxy-ca-file points to a readable PEM CA file for the HTTPS proxy endpoint.\n",
      false,
    );
  });

  it("redacts malformed proxy URLs in JSON output", async () => {
    await validate(
      {
        proxyUrl: "http://user:secret@",
        source: "override",
        errors: ["proxyUrl must use http://"],
      },
      { ok: false, json: true },
    );

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
    await validate(
      { proxyUrl: "http://proxy.example:3128" },
      {
        checks: [
          {
            kind: "denied",
            url: "http://127.0.0.1:12345/",
            ok: true,
            error: "fetch failed",
          },
        ],
      },
    );

    expectValidationText(
      "http://proxy.example:3128/",
      "\nChecks\n  ✓ denied  http://127.0.0.1:12345/ — fetch failed\n",
    );
  });

  it("prints actionable check failure output", async () => {
    await validate(
      { proxyUrl: "http://proxy.example:3128" },
      {
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
        ok: false,
      },
    );

    expectValidationText(
      "http://proxy.example:3128/",
      "\nChecks\n" +
        "  ✓ allowed http://target.example/allowed HTTP 200\n" +
        "  ✗ denied  http://target.example/allowed HTTP 200 — Denied destination was reachable through the proxy\n\n" +
        "Next steps\n" +
        "  Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values.\n",
      false,
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
      run: () => proxyCliRuntime.runDebugProxyCoverageCommand(),
      assertShape: (value: unknown) =>
        expect(value).toEqual({
          summary: expect.objectContaining({ total: expect.any(Number) }),
          entries: expect.any(Array),
        }),
    },
    {
      name: "sessions",
      run: () => proxyCliRuntime.runDebugProxySessionsCommand({ json: true }),
      assertShape: (value: unknown) => expect(value).toEqual({ sessions: [] }),
    },
    {
      name: "query",
      run: () => proxyCliRuntime.runDebugProxyQueryCommand({ json: true, preset: "double-sends" }),
      assertShape: (value: unknown) => expect(value).toEqual({ rows: [] }),
    },
  ])("prints one undecorated JSON object for proxy $name --json", async ({ run, assertShape }) => {
    await run();

    expect(process.stdout["write"]).toHaveBeenCalledOnce();
    assertShape(readOutput());
  });

  it.each([
    {
      name: "sessions",
      run: () => proxyCliRuntime.runDebugProxySessionsCommand({}),
    },
    {
      name: "query",
      run: () => proxyCliRuntime.runDebugProxyQueryCommand({ preset: "double-sends" }),
    },
  ])("preserves the legacy bare-array proxy $name output without --json", async ({ run }) => {
    await run();

    expect(readOutput()).toEqual([]);
  });
});
