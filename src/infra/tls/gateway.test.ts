// Covers gateway TLS loading, fingerprint reporting, generated certificate
// paths, and error handling for missing or invalid material.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTlsFingerprint } from "../../../packages/gateway-client/src/client-address-utils.js";
import {
  TEST_TLS_CERT_PEM as CERT_PEM,
  TEST_TLS_KEY_PEM as KEY_PEM,
} from "../../../test/helpers/tls-fixture.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

type PublishParams = Parameters<
  typeof import("@openclaw/fs-safe/durability").publishFileExclusive
>[0];
type PublishResult = Awaited<
  ReturnType<typeof import("@openclaw/fs-safe/durability").publishFileExclusive>
>;

const { durabilityTestState, resolveSystemBinMock, runExecMock } = vi.hoisted(() => ({
  durabilityTestState: {
    beforePublish: vi.fn<(params: PublishParams) => void | Promise<void>>(),
    afterPublish: vi.fn<(params: PublishParams, result: PublishResult) => void | Promise<void>>(),
    exclusiveCopy: false,
    syncOutcome: undefined as
      | { status: "synced" }
      | { status: "unsupported"; code?: string }
      | undefined,
  },
  resolveSystemBinMock: vi.fn(() => "/usr/bin/openssl"),
  runExecMock: vi.fn(),
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (params: PublishParams) => {
      await durabilityTestState.beforePublish(params);
      const result = durabilityTestState.exclusiveCopy
        ? {
            ...(await copyTlsPublication(params)),
            directorySync: await actual.syncDirectory(path.dirname(params.targetPath)),
          }
        : await actual.publishFileExclusive(params);
      await durabilityTestState.afterPublish(params, result);
      return {
        ...result,
        directorySync: durabilityTestState.syncOutcome ?? result.directorySync,
      };
    },
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) =>
      durabilityTestState.syncOutcome ?? (await actual.syncDirectory(...args)),
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: runExecMock,
}));

vi.mock("../resolve-system-bin.js", () => ({ resolveSystemBin: resolveSystemBinMock }));

import { inspectGatewayTlsCertificate, loadGatewayTlsServerRuntime } from "./gateway.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-gateway-tls-test-");

function resolveOpenSslOutput(args: string[], flag: "-keyout" | "-out"): string {
  const outputPath = args.at(args.indexOf(flag) + 1);
  if (!outputPath) {
    throw new Error(`missing ${flag} output path`);
  }
  return outputPath;
}

async function writeGeneratedTlsPair(args: string[]): Promise<void> {
  await Promise.all([
    fs.writeFile(resolveOpenSslOutput(args, "-out"), CERT_PEM, "utf8"),
    fs.writeFile(resolveOpenSslOutput(args, "-keyout"), KEY_PEM, "utf8"),
  ]);
}

// Model the public copy result with distinct file identity; fs-safe owns fallback selection.
async function copyTlsPublication(params: PublishParams) {
  expect(params.strategy).toBe("link-or-copy");
  const target = await fs.open(params.targetPath, "wx+", 0o600);
  try {
    await target.chmod(0o600);
    await target.writeFile(await fs.readFile(params.sourcePath));
    await target.sync();
    return { method: "exclusive-copy" as const, identity: await target.stat() };
  } finally {
    await target.close();
  }
}

function expectExclusiveCopies() {
  expect(durabilityTestState.afterPublish).toHaveBeenCalledTimes(2);
  for (const [params, result] of durabilityTestState.afterPublish.mock.calls) {
    expect(params.strategy).toBe("link-or-copy");
    expect(result.method).toBe("exclusive-copy");
  }
}

afterEach(async () => {
  durabilityTestState.beforePublish.mockReset();
  durabilityTestState.afterPublish.mockReset();
  durabilityTestState.exclusiveCopy = false;
  durabilityTestState.syncOutcome = undefined;
  resolveSystemBinMock.mockClear();
  runExecMock.mockReset();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

describe("loadGatewayTlsServerRuntime", () => {
  it("disables tls when config is absent or disabled", async () => {
    await expect(loadGatewayTlsServerRuntime(undefined)).resolves.toEqual({
      enabled: false,
      required: false,
    });
    await expect(loadGatewayTlsServerRuntime({ enabled: false })).resolves.toEqual({
      enabled: false,
      required: false,
    });
  });

  it.each([1, 100])("loads existing cert/key with a %i-certificate CA bundle", async (count) => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const caPath = path.join(dir, "gateway-ca.pem");
    await fs.writeFile(certPath, CERT_PEM, "utf8");
    await fs.writeFile(keyPath, KEY_PEM, "utf8");
    const caBundle = (CERT_PEM + "\n").repeat(count);
    await fs.writeFile(caPath, caBundle, "utf8");

    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath,
      keyPath,
      caPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(true);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.caPath).toBe(caPath);
    expect(result.fingerprintSha256).toBe(
      normalizeTlsFingerprint(new X509Certificate(CERT_PEM).fingerprint256 ?? ""),
    );
    expect(result.tlsOptions?.cert).toBe(CERT_PEM);
    expect(result.tlsOptions?.key).toBe(KEY_PEM);
    expect(result.tlsOptions?.ca).toBe(caBundle);
    expect(result.tlsOptions?.minVersion).toBe("TLSv1.3");
    expect(result.error).toBeUndefined();
  });

  it("fails closed when cert/key are missing and auto generation is disabled", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "missing-cert.pem");
    const keyPath = path.join(dir, "missing-key.pem");

    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toBe("gateway tls: cert/key missing");
  });

  it.each(["key", "cert"] as const)(
    "does not replace an existing %s or generate its missing counterpart",
    async (existing) => {
      const dir = await createTempDir();
      const certPath = path.join(dir, "gateway-cert.pem");
      const keyPath = path.join(dir, "gateway-key.pem");
      const existingPath = existing === "cert" ? certPath : keyPath;
      await fs.writeFile(existingPath, "existing material");

      const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

      expect(result).toMatchObject({
        enabled: false,
        required: true,
        error: "gateway tls: cert/key missing",
      });
      expect(runExecMock).not.toHaveBeenCalled();
      await expect(fs.readFile(existingPath, "utf8")).resolves.toBe("existing material");
      await expect(fs.readdir(dir)).resolves.toEqual([path.basename(existingPath)]);
    },
  );

  it.each(["key", "cert"] as const)(
    "bounds generation and cleans a partial staged %s",
    async (partialOutput) => {
      const dir = await createTempDir();
      const certPath = path.join(dir, "gateway-cert.pem");
      const keyPath = path.join(dir, "gateway-key.pem");
      runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = resolveOpenSslOutput(args, partialOutput === "key" ? "-keyout" : "-out");
        await fs.writeFile(outputPath, partialOutput === "key" ? KEY_PEM : CERT_PEM, "utf8");
        throw new Error("openssl timed out");
      });

      const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

      expect(runExecMock).toHaveBeenCalledOnce();
      const [command, args, options] = runExecMock.mock.calls[0] as [
        string,
        string[],
        { logOutput: boolean; timeoutMs: number },
      ];
      expect(command).toBe("/usr/bin/openssl");
      expect(resolveOpenSslOutput(args, "-keyout")).not.toBe(keyPath);
      expect(resolveOpenSslOutput(args, "-out")).not.toBe(certPath);
      expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
      expect(result).toMatchObject({ enabled: false, required: true, certPath, keyPath });
      expect(result.error).toContain("openssl timed out");
      await expect(fs.access(certPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    },
  );

  it("validates and publishes a generated pair with private modes", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });

    const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

    expect(result.enabled).toBe(true);
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
    await expect(fs.readdir(dir).then((entries) => entries.toSorted())).resolves.toEqual([
      "gateway-cert.pem",
      "gateway-key.pem",
    ]);
    if (process.platform !== "win32") {
      expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("syncs generated certificate data before publishing final paths", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const events: string[] = [];
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (flags === "r+" && ["cert.pem", "key.pem"].includes(path.basename(String(filePath)))) {
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          events.push(`sync:${path.basename(String(filePath))}`);
          await originalSync();
        });
      }
      return handle;
    });
    durabilityTestState.beforePublish.mockImplementation(({ sourcePath }) => {
      events.push(`publish:${path.basename(sourcePath)}`);
    });

    try {
      await expect(
        loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath }),
      ).resolves.toMatchObject({ enabled: true });
    } finally {
      openSpy.mockRestore();
    }

    expect(events).toEqual(
      expect.arrayContaining([
        "sync:cert.pem",
        "publish:cert.pem",
        "sync:key.pem",
        "publish:key.pem",
      ]),
    );
    expect(durabilityTestState.beforePublish).toHaveBeenCalledTimes(2);
    expect(events.indexOf("sync:cert.pem")).toBeLessThan(events.indexOf("publish:cert.pem"));
    expect(events.indexOf("sync:key.pem")).toBeLessThan(events.indexOf("publish:key.pem"));
  });

  it("creates nested TLS directories before publishing generated material", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "nested", "tls", "gateway-cert.pem");
    const keyPath = path.join(dir, "nested", "tls", "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });

    const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

    expect(result.enabled).toBe(true);
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
  });

  it("preserves the published certificate when key publication loses a race", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    let raced = false;
    durabilityTestState.beforePublish.mockImplementation(async ({ targetPath }) => {
      if (path.basename(targetPath) === "gateway-key.pem") {
        await fs.writeFile(targetPath, "foreign key material", { encoding: "utf8", flag: "wx" });
        raced = true;
      }
    });

    const result = await loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath });

    expect(raced).toBe(true);
    expect(durabilityTestState.afterPublish).toHaveBeenCalledOnce();
    expect(result.enabled).toBe(false);
    expect(result.error).toContain("failed to generate cert");
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe("foreign key material");
  });

  it.runIf(process.platform !== "win32")(
    "publishes through the pinned canonical directory after a symlink retarget",
    async () => {
      const root = await createTempDir();
      const firstDirectory = path.join(root, "first");
      const secondDirectory = path.join(root, "second");
      const requestedDirectory = path.join(root, "requested");
      await fs.mkdir(firstDirectory);
      await fs.mkdir(secondDirectory);
      await fs.symlink(firstDirectory, requestedDirectory);
      const certPath = path.join(requestedDirectory, "gateway-cert.pem");
      const keyPath = path.join(requestedDirectory, "gateway-key.pem");
      runExecMock.mockImplementation(async (_command: string, args: string[]) => {
        await writeGeneratedTlsPair(args);
      });
      let retargeted = false;
      durabilityTestState.beforePublish.mockImplementation(async ({ targetPath }) => {
        if (path.basename(targetPath) === "gateway-cert.pem") {
          retargeted = true;
          await fs.unlink(requestedDirectory);
          await fs.symlink(secondDirectory, requestedDirectory);
        }
      });
      durabilityTestState.afterPublish.mockImplementation(async ({ targetPath }) => {
        if (path.basename(targetPath) === "gateway-cert.pem") {
          expect(await fs.realpath(requestedDirectory)).toBe(secondDirectory);
          await fs.unlink(requestedDirectory);
          await fs.symlink(firstDirectory, requestedDirectory);
        }
      });

      await expect(
        loadGatewayTlsServerRuntime({ enabled: true, certPath, keyPath }),
      ).resolves.toMatchObject({
        enabled: true,
      });
      expect(retargeted).toBe(true);
      await expect(
        fs.readdir(firstDirectory).then((entries) => entries.toSorted()),
      ).resolves.toEqual(["gateway-cert.pem", "gateway-key.pem"]);
      await expect(fs.readdir(secondDirectory)).resolves.toEqual([]);
    },
  );

  it("publishes best-effort and warns once when hard links are unavailable", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    durabilityTestState.exclusiveCopy = true;

    const result = await loadGatewayTlsServerRuntime(
      { enabled: true, certPath, keyPath },
      { warn },
    );

    expectExclusiveCopies();
    expect(result.enabled).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[GATEWAY_TLS_DEGRADED]"), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "atomic hard-link publication unavailable",
      state: "best-effort",
    });
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
    await expect(fs.readdir(dir).then((entries) => entries.toSorted())).resolves.toEqual([
      "gateway-cert.pem",
      "gateway-key.pem",
    ]);
    if (process.platform !== "win32") {
      expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports degraded durability when Windows cannot flush the publication directory", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    durabilityTestState.syncOutcome = { status: "unsupported", code: "EISDIR" };

    const result = await loadGatewayTlsServerRuntime(
      { enabled: true, certPath, keyPath },
      { warn },
    );

    expect(result.enabled).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[GATEWAY_TLS_DEGRADED]"), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "directory durability unavailable",
      state: "best-effort",
    });
  });

  it("reports atomic and durability degradations independently", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    durabilityTestState.exclusiveCopy = true;
    durabilityTestState.syncOutcome = { status: "unsupported", code: "EISDIR" };

    const result = await loadGatewayTlsServerRuntime(
      { enabled: true, certPath, keyPath },
      { warn },
    );

    expectExclusiveCopies();
    expect(result.enabled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "atomic hard-link publication unavailable",
      state: "best-effort",
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "directory durability unavailable",
      state: "best-effort",
    });
  });

  it("reports load failures for invalid pem files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    await fs.writeFile(certPath, "not a certificate\n", "utf8");
    await fs.writeFile(keyPath, KEY_PEM, "utf8");

    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toContain("gateway tls: failed to load cert");
  });

  it("falls back to default paths when certPath and keyPath are empty strings", async () => {
    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: "",
      keyPath: "",
      autoGenerate: false,
    });

    // Empty paths must not reach downstream — they must be replaced with defaults.
    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("");
  });

  it("falls back to default paths when certPath and keyPath are whitespace-only", async () => {
    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: "   ",
      keyPath: "\t",
      autoGenerate: false,
    });

    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("   ");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("\t");
  });

  it("does not fall back for non-empty paths with leading/trailing spaces", async () => {
    const result = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: "  /etc/ssl/cert.pem  ",
      keyPath: "  /etc/ssl/private/server.key  ",
      autoGenerate: false,
    });

    // Non-empty paths are passed through verbatim; resolveUserPath owns
    // normalization (it trims), so they must not fall back to default names.
    expect(result.certPath).not.toContain("gateway-cert.pem");
    expect(result.keyPath).not.toContain("gateway-key.pem");
  });
});

describe("configured TLS leaf byte limits", () => {
  const limit = 64 * 1024;

  it.each([
    ["cert", limit],
    ["cert", limit + 1],
    ["key", limit],
    ["key", limit + 1],
    ["inspection", limit],
    ["inspection", limit + 1],
  ] as const)("bounds %s at %i bytes and closes its descriptors", async (target, bytes) => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key.pem");
    const cert = target === "key" ? CERT_PEM : CERT_PEM.padEnd(bytes, "\n");
    const key = target === "key" ? KEY_PEM.padEnd(bytes, "\n") : KEY_PEM;
    await fs.writeFile(certPath, cert);
    await fs.writeFile(keyPath, key);
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      handles.push(handle);
      return handle;
    });

    if (target === "inspection") {
      const result = await inspectGatewayTlsCertificate({ enabled: true, certPath });
      expect(result.ok).toBe(bytes === limit);
      if (result.ok) {
        expect(result.value.cert).toBe(cert);
        expect(result.value.fingerprintSha256).toBe(
          normalizeTlsFingerprint(new X509Certificate(CERT_PEM).fingerprint256),
        );
      } else {
        expect(result.error).toContain("File exceeds 65536 bytes");
      }
    } else {
      const result = await loadGatewayTlsServerRuntime({
        enabled: true,
        certPath,
        keyPath,
        autoGenerate: false,
      });
      expect(result.enabled).toBe(bytes === limit);
      expect(result.required).toBe(true);
      if (bytes === limit) {
        expect(result.tlsOptions?.cert).toBe(cert);
        expect(result.tlsOptions?.key).toBe(key);
      } else {
        expect(result.error).toContain("File exceeds 65536 bytes");
        expect(result.tlsOptions).toBeUndefined();
      }
    }
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    expect(runExecMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "accepts symlinked chains in both entry points",
    async () => {
      const dir = await createTempDir();
      const certPath = path.join(dir, "cert-link.pem");
      const keyPath = path.join(dir, "key-link.pem");
      const chain = [CERT_PEM, CERT_PEM].join("\n");
      await fs.writeFile(path.join(dir, "cert.pem"), chain);
      await fs.writeFile(path.join(dir, "key.pem"), KEY_PEM);
      await fs.symlink("cert.pem", certPath);
      await fs.symlink("key.pem", keyPath);
      const inspection = await inspectGatewayTlsCertificate({ enabled: true, certPath });
      expect(inspection).toMatchObject({ ok: true, value: { cert: chain } });
      const runtime = await loadGatewayTlsServerRuntime({
        enabled: true,
        certPath,
        keyPath,
        autoGenerate: false,
      });
      expect(runtime).toMatchObject({ enabled: true, tlsOptions: { cert: chain, key: KEY_PEM } });
      expect(runExecMock).not.toHaveBeenCalled();
    },
  );
});
