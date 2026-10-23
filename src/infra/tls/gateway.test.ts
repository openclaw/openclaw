import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type * as Durability from "@openclaw/fs-safe/durability";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeTlsFingerprint } from "../../../packages/gateway-client/src/client-address-utils.js";
import {
  TEST_TLS_CERT_PEM as CERT_PEM,
  TEST_TLS_KEY_PEM as KEY_PEM,
} from "../../../test/helpers/tls-fixture.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

type PublishParams = Parameters<typeof Durability.publishFileExclusive>[0];
type PublishResult = Awaited<ReturnType<typeof Durability.publishFileExclusive>>;
type ExecArgs = [string, string[], { logOutput: boolean; timeoutMs: number }];

const { durabilityTestState, runExecMock } = vi.hoisted(() => ({
  durabilityTestState: {
    beforePublish: vi.fn<(params: PublishParams) => void | Promise<void>>(),
    afterPublish: vi.fn<(params: PublishParams, result: PublishResult) => void | Promise<void>>(),
    exclusiveCopy: false,
    syncOutcome: undefined as Awaited<ReturnType<typeof Durability.syncDirectory>> | undefined,
  },
  runExecMock: vi.fn<(...args: ExecArgs) => Promise<void>>(),
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

vi.mock("../resolve-system-bin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolve-system-bin.js")>()),
  resolveSystemBin: () => "/usr/bin/openssl",
}));

import { inspectGatewayTlsCertificate, loadGatewayTlsServerRuntime } from "./gateway.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-gateway-tls-test-");
const fingerprint = normalizeTlsFingerprint(new X509Certificate(CERT_PEM).fingerprint256);

async function createTlsConfig(dir?: string) {
  const directory = dir ?? (await createTempDir());
  return {
    enabled: true as const,
    certPath: path.join(directory, "gateway-cert.pem"),
    keyPath: path.join(directory, "gateway-key.pem"),
  };
}

function resolveOpenSslOutput(args: string[], flag: "-keyout" | "-out"): string {
  const outputPath = args.at(args.indexOf(flag) + 1);
  if (!outputPath) {
    throw new Error(`missing ${flag} output path`);
  }
  return outputPath;
}

async function writeGeneratedTlsPair(_command: string, args: string[]): Promise<void> {
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
    return {
      method: "exclusive-copy" as const,
      identity: await target.stat(),
      exactIdentity: await target.stat({ bigint: true }),
    };
  } finally {
    await target.close();
  }
}

afterEach(async () => {
  durabilityTestState.beforePublish.mockReset();
  durabilityTestState.afterPublish.mockReset();
  durabilityTestState.exclusiveCopy = false;
  durabilityTestState.syncOutcome = undefined;
  runExecMock.mockReset();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it("disables tls when config is absent or disabled", async () => {
  const disabled = { enabled: false };
  await expect(loadGatewayTlsServerRuntime(undefined)).resolves.toEqual(disabled);
  await expect(loadGatewayTlsServerRuntime({ enabled: false })).resolves.toEqual(disabled);
});

it("loads existing cert/key with a 100-certificate CA bundle", async () => {
  const config = await createTlsConfig();
  const { certPath, keyPath } = config;
  const caPath = path.join(path.dirname(certPath), "gateway-ca.pem");
  await fs.writeFile(certPath, CERT_PEM, "utf8");
  await fs.writeFile(keyPath, KEY_PEM, "utf8");
  const caBundle = (CERT_PEM + "\n").repeat(100);
  await fs.writeFile(caPath, caBundle, "utf8");

  const result = await loadGatewayTlsServerRuntime({ ...config, caPath, autoGenerate: false });
  expect(result).toMatchObject({
    ...config,
    caPath,
    fingerprintSha256: fingerprint,
    tlsOptions: { cert: CERT_PEM, key: KEY_PEM, ca: caBundle, minVersion: "TLSv1.3" },
  });
  expect(result.error).toBeUndefined();
});

it.each([
  { cert: undefined, key: "existing material", error: "gateway tls: cert/key missing" },
  { cert: "not a certificate\n", key: KEY_PEM, error: "gateway tls: failed to load cert" },
])("rejects invalid material without replacing it: $error", async ({ cert, key, error }) => {
  const config = await createTlsConfig();
  const { certPath, keyPath } = config;
  if (cert !== undefined) {
    await fs.writeFile(certPath, cert);
  }
  await fs.writeFile(keyPath, key);
  const result = await loadGatewayTlsServerRuntime({
    ...config,
    autoGenerate: cert === undefined,
  });
  expect(result).toMatchObject({
    enabled: false,
    certPath,
    keyPath,
    error: cert === undefined ? error : expect.stringContaining(error),
  });
  expect(runExecMock).not.toHaveBeenCalled();
  await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(key);
  if (cert === undefined) {
    await expect(fs.readdir(path.dirname(keyPath))).resolves.toEqual([path.basename(keyPath)]);
  }
});

it("bounds generation and cleans a partial staged key", async () => {
  const config = await createTlsConfig();
  const { certPath, keyPath } = config;
  runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
    const outputPath = resolveOpenSslOutput(args, "-keyout");
    await fs.writeFile(outputPath, KEY_PEM, "utf8");
    throw new Error("openssl timed out");
  });

  const result = await loadGatewayTlsServerRuntime(config);

  expect(runExecMock).toHaveBeenCalledOnce();
  const [command, args, options] = expectDefined(runExecMock.mock.calls[0], "OpenSSL invocation");
  expect({ command, options }).toEqual({
    command: "/usr/bin/openssl",
    options: { logOutput: false, timeoutMs: 30_000 },
  });
  expect(resolveOpenSslOutput(args, "-keyout")).not.toBe(keyPath);
  expect(resolveOpenSslOutput(args, "-out")).not.toBe(certPath);
  expect(result).toMatchObject({
    enabled: false,
    certPath,
    keyPath,
    error: expect.stringContaining("openssl timed out"),
  });
  await expect(fs.readdir(path.dirname(certPath))).resolves.toEqual([]);
});

it("syncs generated certificate data before publishing final paths", async () => {
  const config = await createTlsConfig();
  const events: string[] = [];
  runExecMock.mockImplementation(writeGeneratedTlsPair);
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
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

  await expect(loadGatewayTlsServerRuntime(config)).resolves.toMatchObject({ enabled: true });

  expect(events).toEqual(
    ["cert.pem", "key.pem"].flatMap((name) => [`sync:${name}`, `publish:${name}`]),
  );
});

it("preserves the published certificate when key publication loses a race", async () => {
  const config = await createTlsConfig();
  const { certPath, keyPath } = config;
  runExecMock.mockImplementation(writeGeneratedTlsPair);
  durabilityTestState.beforePublish.mockImplementation(async ({ targetPath }) => {
    if (path.basename(targetPath) === "gateway-key.pem") {
      await fs.writeFile(targetPath, "foreign key material", { encoding: "utf8", flag: "wx" });
    }
  });

  const result = await loadGatewayTlsServerRuntime(config);

  expect(durabilityTestState.afterPublish).toHaveBeenCalledOnce();
  expect(result.enabled).toBe(false);
  expect(result.error).toContain("failed to generate cert");
  await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
  await expect(fs.readFile(keyPath, "utf8")).resolves.toBe("foreign key material");
});

it.runIf(process.platform !== "win32")(
  "pins publication paths across symlink retargets",
  async () => {
    const root = await createTempDir();
    const firstDirectory = path.join(root, "first");
    const secondDirectory = path.join(root, "second");
    const requestedDirectory = path.join(root, "requested");
    await fs.mkdir(firstDirectory);
    await fs.mkdir(secondDirectory);
    await fs.symlink(firstDirectory, requestedDirectory);
    const config = await createTlsConfig(requestedDirectory);
    runExecMock.mockImplementation(writeGeneratedTlsPair);
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

    await expect(loadGatewayTlsServerRuntime(config)).resolves.toMatchObject({ enabled: true });
    expect(retargeted).toBe(true);
    await expect(fs.readdir(firstDirectory).then((entries) => entries.toSorted())).resolves.toEqual(
      ["gateway-cert.pem", "gateway-key.pem"],
    );
    await expect(fs.readdir(secondDirectory)).resolves.toEqual([]);
  },
);

it("reports atomic and durability degradations independently", async () => {
  const config = await createTlsConfig();
  const { certPath, keyPath } = config;
  const warn = vi.fn();
  runExecMock.mockImplementation(writeGeneratedTlsPair);
  durabilityTestState.exclusiveCopy = true;
  durabilityTestState.syncOutcome = { status: "unsupported", code: "EISDIR" };

  const result = await loadGatewayTlsServerRuntime(config, { warn });

  expect(durabilityTestState.afterPublish).toHaveBeenCalledTimes(2);
  expect(result.enabled).toBe(true);
  expect(warn).toHaveBeenCalledTimes(2);
  if (process.platform !== "win32") {
    expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
  }
  const degradation = {
    event: "gateway.tls.degraded",
    ownerKind: "gateway",
    ownerId: "tls",
    state: "best-effort",
  };
  for (const reason of [
    "atomic hard-link publication unavailable",
    "directory durability unavailable",
  ]) {
    expect(warn).toHaveBeenCalledWith(expect.any(String), { ...degradation, reason });
  }
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
const limit = 64 * 1024;

it.each([
  ["cert", limit],
  ["cert", limit + 1],
  ["key", limit + 1],
  ["inspection", limit],
  ["inspection", limit + 1],
] as const)("bounds %s at %i bytes and closes its descriptors", async (target, bytes) => {
  const config = await createTlsConfig();
  const { certPath, keyPath } = config;
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
    const result = await inspectGatewayTlsCertificate(config);
    expect(result).toMatchObject(
      bytes === limit
        ? { ok: true, value: { cert, fingerprintSha256: fingerprint } }
        : { ok: false, error: expect.stringContaining("File exceeds 65536 bytes") },
    );
  } else {
    const result = await loadGatewayTlsServerRuntime({ ...config, autoGenerate: false });
    expect(result).toMatchObject({ enabled: bytes === limit });
    if (bytes === limit) {
      expect(result.tlsOptions).toMatchObject({ cert, key });
    } else {
      expect(result.error).toContain("File exceeds 65536 bytes");
      expect(result.tlsOptions).toBeUndefined();
    }
  }
  expect(handles.length).toBeGreaterThan(0);
  expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  expect(runExecMock).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("loads and inspects symlinked chains", async () => {
  const dir = await createTempDir();
  const certPath = path.join(dir, "cert-link.pem");
  const keyPath = path.join(dir, "key-link.pem");
  const config = { enabled: true, certPath, keyPath, autoGenerate: false };
  const chain = [CERT_PEM, CERT_PEM].join("\n");
  await fs.writeFile(path.join(dir, "cert.pem"), chain);
  await fs.writeFile(path.join(dir, "key.pem"), KEY_PEM);
  await fs.symlink("cert.pem", certPath);
  await fs.symlink("key.pem", keyPath);
  const inspection = await inspectGatewayTlsCertificate(config);
  expect(inspection).toMatchObject({ ok: true, value: { cert: chain } });
  const runtime = await loadGatewayTlsServerRuntime(config);
  expect(runtime).toMatchObject({ enabled: true, tlsOptions: { cert: chain, key: KEY_PEM } });
  expect(runExecMock).not.toHaveBeenCalled();
});
