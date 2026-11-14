import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type * as Durability from "@openclaw/fs-safe/durability";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeTlsFingerprint } from "../../../packages/gateway-client/src/client-address-utils.js";
import {
  TEST_TLS_CERT_PEM as CERT_PEM,
  TEST_TLS_KEY_PEM as KEY_PEM,
} from "../../../test/helpers/tls-fixture.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { CONFIG_DIR } from "../../utils.js";

type PublishParams = Parameters<typeof Durability.publishFileExclusive>[0];
type ExecArgs = [string, string[], { logOutput: boolean; timeoutMs: number }];

const { publication, exec } = vi.hoisted(() => ({
  publication: {
    beforePublish: vi.fn<(params: PublishParams) => void | Promise<void>>(),
    afterPublish: vi.fn<(params: PublishParams) => void | Promise<void>>(),
    exclusiveCopy: false,
  },
  exec: vi.fn<(...args: ExecArgs) => Promise<void>>(),
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (params: PublishParams) => {
      await publication.beforePublish(params);
      const result = publication.exclusiveCopy
        ? await copyTlsPublication(params)
        : await actual.publishFileExclusive(params);
      await publication.afterPublish(params);
      return result;
    },
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: exec,
}));

vi.mock("../resolve-system-bin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolve-system-bin.js")>()),
  resolveSystemBin: () => "/usr/bin/openssl",
}));

import {
  inspectGatewayTlsCertificate as inspectTls,
  loadGatewayTlsServerRuntime as loadTls,
} from "./gateway.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-gateway-tls-test-");
const fingerprint = normalizeTlsFingerprint(new X509Certificate(CERT_PEM).fingerprint256);
const limit = 64 * 1024;
const posix = process.platform !== "win32";

async function createConfig(cert?: string, key = KEY_PEM) {
  const directory = await createTempDir();
  const config = {
    enabled: true as const,
    certPath: path.join(directory, "gateway-cert.pem"),
    keyPath: path.join(directory, "gateway-key.pem"),
  };
  if (cert !== undefined) {
    await Promise.all([fs.writeFile(config.certPath, cert), fs.writeFile(config.keyPath, key)]);
  }
  return config;
}

function observeOpen(
  observer: (handle: Awaited<ReturnType<typeof fs.open>>, file: string, flags: unknown) => void,
) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    observer(handle, String(file), flags);
    return handle;
  });
}

function opensslOutput(args: string[], flag: "-keyout" | "-out"): string {
  return expectDefined(args.at(args.indexOf(flag) + 1), `missing ${flag} output path`);
}

async function writeGeneratedTlsPair(_command: string, args: string[]): Promise<void> {
  await Promise.all([
    fs.writeFile(opensslOutput(args, "-out"), CERT_PEM, "utf8"),
    fs.writeFile(opensslOutput(args, "-keyout"), KEY_PEM, "utf8"),
  ]);
}

// Native exclusive copy keeps the fallback's separate identity and private source mode.
async function copyTlsPublication(params: PublishParams) {
  await fs.copyFile(params.sourcePath, params.targetPath, constants.COPYFILE_EXCL);
  return {
    method: "exclusive-copy" as const,
    directorySync: { status: "unsupported" as const, code: "EISDIR" },
    identity: await fs.stat(params.targetPath),
    exactIdentity: await fs.stat(params.targetPath, { bigint: true }),
  };
}

afterEach(async () => {
  publication.beforePublish.mockReset();
  publication.afterPublish.mockReset();
  publication.exclusiveCopy = false;
  exec.mockReset();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});
beforeEach(() => {
  exec.mockImplementation(writeGeneratedTlsPair);
});

it("disables tls when config is absent or disabled", async () => {
  const disabled = { enabled: false };
  await expect(loadTls(undefined)).resolves.toEqual(disabled);
  await expect(loadTls({ enabled: false })).resolves.toEqual(disabled);
});

it("loads and inspects a chain with a large CA bundle and configured symlinks", async () => {
  const chain = `${CERT_PEM}\n${CERT_PEM}`.padEnd(limit, "\n");
  const config = await createConfig(chain);
  const caPath = path.join(path.dirname(config.certPath), "gateway-ca.pem");
  const caBundle = (CERT_PEM + "\n").repeat(100);
  await fs.writeFile(caPath, caBundle, "utf8");
  if (posix) {
    for (const field of ["certPath", "keyPath"] as const) {
      await fs.symlink(path.basename(config[field]), `${config[field]}.link`);
      config[field] += ".link";
    }
  }
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  observeOpen((handle) => handles.push(handle));
  await expect(inspectTls(config)).resolves.toMatchObject({
    ok: true,
    value: { cert: chain, fingerprintSha256: fingerprint },
  });
  const result = await loadTls({ ...config, caPath, autoGenerate: false });
  expect(result).toMatchObject({
    enabled: true,
    fingerprintSha256: fingerprint,
    tlsOptions: { cert: chain, key: KEY_PEM, ca: caBundle, minVersion: "TLSv1.3" },
  });
  expect(handles.length).toBeGreaterThan(0);
  expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  expect(exec).not.toHaveBeenCalled();
});

it.each([
  { cert: undefined, key: "existing material", error: "gateway tls: cert/key missing" },
  { cert: "not a certificate\n", key: KEY_PEM, error: "gateway tls: failed to load cert" },
  { cert: undefined, key: undefined, error: "openssl timed out" },
])("rejects TLS failure without partial replacement: $error", async ({ cert, key, error }) => {
  const config = await createConfig(cert, key);
  const { certPath, keyPath } = config;
  if (cert === undefined && key !== undefined) {
    await fs.writeFile(keyPath, key);
  }
  if (key === undefined) {
    exec.mockImplementationOnce(async (_command, args) => {
      await fs.writeFile(opensslOutput(args, "-keyout"), KEY_PEM, "utf8");
      throw new Error(error);
    });
  }
  await expect(loadTls({ ...config, autoGenerate: cert === undefined })).resolves.toMatchObject({
    enabled: false,
    error: key !== undefined && cert === undefined ? error : expect.stringContaining(error),
  });
  if (key !== undefined) {
    expect(exec).not.toHaveBeenCalled();
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(key);
  } else {
    const [, args, options] = expectDefined(exec.mock.calls[0], "OpenSSL invocation");
    expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
    expect(opensslOutput(args, "-keyout")).not.toBe(keyPath);
    expect(opensslOutput(args, "-out")).not.toBe(certPath);
  }
  if (cert === undefined) {
    await expect(fs.readdir(path.dirname(keyPath))).resolves.toEqual(
      key === undefined ? [] : [path.basename(keyPath)],
    );
  }
});

it("publishes synced private files through pinned paths and reports degradations", async () => {
  const config = await createConfig();
  const directory = path.dirname(config.certPath);
  const foreign = await createTempDir();
  // Keep the link inside a tracked directory so cleanup owns it on every platform.
  const requested = path.join(foreign, "requested");
  if (posix) {
    await fs.symlink(directory, requested);
    config.certPath = path.join(requested, "gateway-cert.pem");
    config.keyPath = path.join(requested, "gateway-key.pem");
  }
  const events: string[] = [];
  const warn = vi.fn();
  publication.exclusiveCopy = true;
  observeOpen((handle, filePath, flags) => {
    if (flags === "r+" && ["cert.pem", "key.pem"].includes(path.basename(filePath))) {
      const originalSync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        events.push(`sync:${path.basename(filePath)}`);
        await originalSync();
      });
    }
  });
  publication.beforePublish.mockImplementation(async ({ sourcePath, targetPath }) => {
    events.push(`publish:${path.basename(sourcePath)}`);
    if (posix && path.basename(targetPath) === "gateway-cert.pem") {
      await fs.unlink(requested);
      await fs.symlink(foreign, requested);
    }
  });
  publication.afterPublish.mockImplementation(async ({ targetPath }) => {
    if (posix && path.basename(targetPath) === "gateway-cert.pem") {
      expect(await fs.realpath(requested)).toBe(foreign);
      await fs.unlink(requested);
      await fs.symlink(directory, requested);
    }
  });
  await expect(loadTls(config, { warn })).resolves.toMatchObject({ enabled: true });
  expect(events).toEqual(["sync:cert.pem", "publish:cert.pem", "sync:key.pem", "publish:key.pem"]);
  const files = await fs.readdir(directory);
  expect(files.toSorted()).toEqual(["gateway-cert.pem", "gateway-key.pem"]);
  await expect(fs.readdir(foreign)).resolves.toEqual(posix ? ["requested"] : []);
  if (posix) {
    for (const file of [config.certPath, config.keyPath]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  }
  expect(warn).toHaveBeenCalledTimes(2);
  for (const reason of [
    "atomic hard-link publication unavailable",
    "directory durability unavailable",
  ]) {
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason }));
  }
});

it("preserves the published certificate when key publication loses a race", async () => {
  const config = await createConfig();
  const { certPath, keyPath } = config;
  publication.beforePublish.mockImplementation(async ({ targetPath }) => {
    if (path.basename(targetPath) === "gateway-key.pem") {
      await fs.writeFile(targetPath, "foreign key material", { encoding: "utf8", flag: "wx" });
    }
  });
  await expect(loadTls(config)).resolves.toMatchObject({
    enabled: false,
    error: expect.stringContaining("failed to generate cert"),
  });
  await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
  await expect(fs.readFile(keyPath, "utf8")).resolves.toBe("foreign key material");
});

it("falls back to default paths when certPath and keyPath are whitespace-only", async () => {
  const config = { enabled: true, certPath: "   ", keyPath: "\t", autoGenerate: false };
  await expect(loadTls(config)).resolves.toMatchObject({
    certPath: path.join(CONFIG_DIR, "gateway/tls/gateway-cert.pem"),
    keyPath: path.join(CONFIG_DIR, "gateway/tls/gateway-key.pem"),
  });
});
it.each(["cert", "key", "inspection"])("bounds %s and closes descriptors", async (target) => {
  const cert = target === "key" ? CERT_PEM : CERT_PEM.padEnd(limit + 1, "\n");
  const key = target === "key" ? KEY_PEM.padEnd(limit + 1, "\n") : KEY_PEM;
  const config = await createConfig(cert, key);
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  observeOpen((handle) => handles.push(handle));
  const inspection = target === "inspection";
  const result = inspection
    ? await inspectTls(config)
    : await loadTls({ ...config, autoGenerate: false });
  expect(result).toMatchObject({
    ...(inspection ? { ok: false } : { enabled: false }),
    error: expect.stringContaining("File exceeds 65536 bytes"),
  });
  if ("enabled" in result) {
    expect(result.tlsOptions).toBeUndefined();
  }
  expect(handles.length).toBeGreaterThan(0);
  expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  expect(exec).not.toHaveBeenCalled();
});
