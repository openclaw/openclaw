import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeConfigMock, runProxyValidationMock, serverStopSpy, spawnMock } = vi.hoisted(
  () => ({
    getRuntimeConfigMock: vi.fn(),
    runProxyValidationMock: vi.fn(),
    serverStopSpy: vi.fn(async () => undefined),
    spawnMock: vi.fn(),
  }),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../proxy-capture/proxy-server.js", () => ({
  startDebugProxyServer: vi.fn(async () => ({
    proxyUrl: "http://127.0.0.1:7799",
    stop: serverStopSpy,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../infra/net/proxy/proxy-validation.js", () => ({
  runProxyValidation: runProxyValidationMock,
}));

describe("proxy cli runtime", () => {
  const envKeys = [
    "OPENCLAW_DEBUG_PROXY_DB_PATH",
    "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
    "OPENCLAW_DEBUG_PROXY_CERT_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-cli-runtime-"));
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_CERT_DIR = path.join(tempDir, "certs");
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID;
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
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    serverStopSpy.mockClear();
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { closeDebugProxyCaptureStore } = await import("../proxy-capture/store.sqlite.js");
    closeDebugProxyCaptureStore();
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints proxy validation text and leaves exit code unset on success", async () => {
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({
      proxyUrl: "http://override.example:3128",
      allowedUrls: ["https://allowed.example/"],
      deniedUrls: ["http://127.0.0.1/"],
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
      allowedUrls: ["https://allowed.example/"],
      deniedUrls: ["http://127.0.0.1/"],
      timeoutMs: 1234,
    });
    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation: passed\n" +
        "Effective proxy: http://config-proxy.example:3128/ (config)\n" +
        "- PASS allowed https://example.com/ status=200\n",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("redacts proxy credentials in text output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation: passed\n" +
        "Effective proxy: http://redacted:redacted@proxy.example:3128/ (config)\n",
    );
  });

  it("redacts proxy credentials in JSON output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({ json: true });

    expect(process.stdout.write).toHaveBeenCalledWith(
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

  it("prints proxy validation JSON and sets exit code on failure", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        source: "missing",
        errors: ["proxy validation requires proxy.proxyUrl or OPENCLAW_PROXY_URL"],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({ json: true });

    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          ok: false,
          config: {
            enabled: true,
            source: "missing",
            errors: ["proxy validation requires proxy.proxyUrl or OPENCLAW_PROXY_URL"],
          },
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("stops the proxy server and ends the session when child spawn fails", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    });

    const { runDebugProxyRunCommand } = await import("./proxy-cli.runtime.js");
    const { getDebugProxyCaptureStore } = await import("../proxy-capture/store.sqlite.js");

    await expect(
      runDebugProxyRunCommand({
        commandArgs: ["does-not-exist"],
      }),
    ).rejects.toThrow("spawn failed");

    expect(serverStopSpy).toHaveBeenCalledTimes(1);

    const store = getDebugProxyCaptureStore(
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH!,
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR!,
    );
    const [session] = store.listSessions(5);
    expect(session?.mode).toBe("proxy-run");
    expect(session?.endedAt).toEqual(expect.any(Number));
  });
});
