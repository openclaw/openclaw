import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as timers from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NodeWorkerBundleInstallError } from "../worker/node-bundle-install-protocol.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import {
  buildBundleFixture,
  interruptAfterStagingWrite,
  type BundleFixture,
  type BundleFixtureOptions,
} from "./node-worker-bundle-installer.test-support.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const bundleWarnings = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "node/worker-bundle" ? { ...logger, warn: bundleWarnings } : logger;
    },
  };
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

describe("node worker bundle installer", () => {
  let root: string;
  let server: http.Server | undefined;
  let cleanupPrewarming: (() => Promise<void>) | undefined;
  let defaultFixture: BundleFixture;
  let receipts: FixtureReceiptChannel;

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    const fixtureRoot = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-node-bundle-fixture-"),
    );
    try {
      defaultFixture = await buildBundleFixture(fixtureRoot);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await receipts.close();
  });

  beforeEach(async () => {
    bundleWarnings.mockClear();
    vi.mocked(timers.setTimeout).mockReset();
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-bundle-"));
  });

  afterEach(async () => {
    const cleanup = cleanupPrewarming;
    cleanupPrewarming = undefined;
    await cleanup?.();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function bundleFixture(options?: BundleFixtureOptions): Promise<BundleFixture> {
    if (options) {
      return await buildBundleFixture(root, options);
    }
    // Integrity cases deliberately corrupt their inputs; share preparation, not mutable data.
    return {
      archive: Buffer.from(defaultFixture.archive),
      input: structuredClone(defaultFixture.input),
    };
  }

  const bundleDirectory = (fixture: BundleFixture) =>
    path.join(root, fixture.input.gatewayNamespace, "bundles", fixture.input.build.bundleHash);

  function installation(
    fixture: BundleFixture,
    gatewayUrl: string,
    options: ConstructorParameters<typeof NodeWorkerBundleInstaller>[0] = {},
  ) {
    const installer = new NodeWorkerBundleInstaller({ root, ...options });
    const { gatewayNamespace, build } = fixture.input;
    return {
      installer,
      ensure: (extra: Partial<Parameters<typeof installer.ensure>[0]> = {}) =>
        installer.ensure({ input: fixture.input, gatewayUrl, ...extra }),
      inspect: () => installer.inspect({ gatewayNamespace, bundleHash: build.bundleHash }),
      retain: (bundleHashes = [build.bundleHash]) =>
        installer.retain({ gatewayNamespace, bundleHashes }),
    };
  }

  async function serve(
    archive: Buffer,
    token: string,
    declaredBytes = archive.byteLength,
    respond?: http.RequestListener,
  ) {
    const requests = vi.fn();
    server = http.createServer((req, res) => {
      requests(req.url, req.headers);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(404).end();
        return;
      }
      if (respond) {
        respond(req, res);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(declaredBytes),
      });
      res.end(archive);
    });
    return { gatewayUrl: await listen(server), requests };
  }

  async function setup(options?: BundleFixtureOptions) {
    const fixture = await bundleFixture(options);
    const served = await serve(fixture.archive, fixture.input.archive.token);
    return { fixture, served, ...installation(fixture, served.gatewayUrl) };
  }

  it.each([1, 4])(
    "resumes an authenticated download after %i interruptions",
    async (interruptions) => {
      const fixture = await bundleFixture();
      const partialBytes = Math.floor(fixture.archive.length / (interruptions + 1));
      vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
      const interrupt = interruptAfterStagingWrite();
      let attempts = 0;
      const served = await serve(
        fixture.archive,
        fixture.input.archive.token,
        fixture.archive.length,
        (req, res) => {
          const offset = Number(/^bytes=(\d+)-$/u.exec(req.headers.range ?? "")?.[1] ?? 0);
          res.writeHead(offset ? 206 : 200, {
            "content-length": fixture.archive.length - offset,
            ...(offset
              ? {
                  "content-range": `bytes ${offset}-${fixture.archive.length - 1}/${fixture.archive.length}`,
                }
              : {}),
          });
          if (attempts++ < interruptions) {
            interrupt(res, fixture.archive.subarray(offset, offset + partialBytes));
          } else {
            res.end(fixture.archive.subarray(offset));
          }
        },
      );
      const { ensure, inspect } = installation(fixture, served.gatewayUrl);

      await expect(ensure()).resolves.toEqual(fixture.input.build);

      expect(served.requests.mock.calls.map(([, headers]) => headers.range)).toEqual([
        undefined,
        ...Array.from(
          { length: interruptions },
          (_, index) => `bytes=${(index + 1) * partialBytes}-`,
        ),
      ]);
      await expect(inspect()).resolves.toMatchObject({ status: "installed" });
      await expect(
        fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
      ).resolves.toEqual([fixture.input.build.bundleHash]);
    },
  );

  it.each(["no bytes", "partial", "ignored range"])(
    "stops after three no-progress failures and removes staging (%s)",
    async (mode) => {
      const fixture = await bundleFixture();
      const partialBytes = Math.floor(fixture.archive.length / 2);
      vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
      const interrupt = interruptAfterStagingWrite();
      let requests = 0;
      const served = await serve(
        fixture.archive,
        fixture.input.archive.token,
        fixture.archive.length,
        (_req, res) => {
          requests++;
          if ((mode === "partial" && requests === 1) || mode === "ignored range") {
            res.writeHead(200, { "content-length": fixture.archive.length });
            interrupt(res, fixture.archive.subarray(0, partialBytes));
          } else {
            res.destroy();
          }
        },
      );
      const { ensure } = installation(fixture, served.gatewayUrl);

      await expect(ensure()).rejects.toThrow("3 consecutive no-progress failures");

      expect(served.requests.mock.calls.map(([, headers]) => headers.range)).toEqual(
        mode !== "no bytes"
          ? [undefined, ...Array<string>(3).fill(`bytes=${partialBytes}-`)]
          : [undefined, undefined, undefined],
      );
      await expect(
        fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
      ).resolves.toEqual([]);
    },
  );

  async function prepareLocalArchive(fixture: BundleFixture) {
    const packageRoot = path.join(root, "runtime-package");
    const archivePath = path.join(
      packageRoot,
      "worker-artifacts",
      `${fixture.input.archive.sha256}.tgz`,
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, fixture.archive);
    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(packageRoot);
    return archivePath;
  }

  it("cancels retry backoff without another request and removes staging", async () => {
    const fixture = await bundleFixture();
    const controller = new AbortController();
    vi.mocked(timers.setTimeout).mockImplementation(async (_ms, _value, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error("download cancelled"));
      throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    });
    const served = await serve(
      fixture.archive,
      fixture.input.archive.token,
      fixture.archive.length,
      (_req, res) => res.destroy(),
    );
    const { ensure } = installation(fixture, served.gatewayUrl);

    await expect(ensure({ signal: controller.signal })).rejects.toThrow("download cancelled");
    expect(served.requests).toHaveBeenCalledOnce();
    await expect(
      fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
    ).resolves.toEqual([]);
  });

  it.each(["missing", "malformed"] as const)(
    "quietly repairs a %s bundle cache receipt",
    async (receiptState) => {
      const fixture = await bundleFixture();
      await prepareLocalArchive(fixture);
      const installer = new NodeWorkerBundleInstaller({ root });
      const destination = bundleDirectory(fixture);
      if (receiptState === "malformed") {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, "bootstrap-receipt.json"), "{invalid");
      }
      const inspection = {
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      };

      await expect(installer.inspect(inspection)).resolves.toEqual({
        bundleHash: fixture.input.build.bundleHash,
        status: "missing",
      });
      await expect(
        installer.ensure({ input: fixture.input, gatewayUrl: "ws://127.0.0.1:1" }),
      ).resolves.toEqual(fixture.input.build);
      await expect(installer.inspect(inspection)).resolves.toEqual({
        bundleHash: fixture.input.build.bundleHash,
        status: "installed",
      });
      expect(bundleWarnings).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["receipt", "EACCES"],
    ["manifest", "EIO"],
  ] as const)(
    "reports %s %s failures once per operation while preserving cache repair",
    async (phase, errorCode) => {
      const fixture = await bundleFixture();
      await prepareLocalArchive(fixture);
      const installer = new NodeWorkerBundleInstaller({ root });
      const install = { input: fixture.input, gatewayUrl: "ws://127.0.0.1:1" };
      await installer.ensure(install);
      const destination = bundleDirectory(fixture);
      const failure = Object.assign(new Error("synthetic private message and tool content"), {
        code: errorCode,
        request: { body: "synthetic private request" },
      });
      let failuresRemaining = 2;
      const readFile = fs.readFile.bind(fs);
      const readdir = fs.readdir.bind(fs);
      const readFailure =
        phase === "receipt"
          ? vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
              if (
                args[0] === path.join(destination, "bootstrap-receipt.json") &&
                failuresRemaining > 0
              ) {
                failuresRemaining--;
                throw failure;
              }
              return await readFile(...args);
            })
          : vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
              if (args[0] === destination && failuresRemaining > 0) {
                failuresRemaining--;
                throw failure;
              }
              return await readdir(...args);
            });
      const inspection = {
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      };
      const warning =
        phase === "receipt"
          ? "Worker bundle receipt read failed; treating installation as missing. Check node-host storage permissions and disk health."
          : "Worker bundle cache read failed; treating installation as missing. Check node-host storage permissions and disk health.";

      await expect(installer.inspect(inspection)).resolves.toEqual({
        bundleHash: fixture.input.build.bundleHash,
        status: "missing",
      });
      expect(bundleWarnings).toHaveBeenCalledExactlyOnceWith(warning, { errorCode });
      bundleWarnings.mockClear();
      await expect(installer.ensure(install)).resolves.toEqual(fixture.input.build);
      expect(bundleWarnings).toHaveBeenCalledExactlyOnceWith(warning, { errorCode });
      expect(failuresRemaining).toBe(0);
      readFailure.mockRestore();
      await expect(installer.inspect(inspection)).resolves.toEqual({
        bundleHash: fixture.input.build.bundleHash,
        status: "installed",
      });
      expect(bundleWarnings).toHaveBeenCalledExactlyOnceWith(warning, { errorCode });
    },
  );

  it("installs the exact prepared archive without HTTP and creates a fresh admission receipt", async () => {
    const fixture = await bundleFixture();
    const archivePath = await prepareLocalArchive(fixture);
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const { ensure } = installation(fixture, served.gatewayUrl);

    await expect(ensure()).resolves.toEqual(fixture.input.build);

    expect(served.requests).not.toHaveBeenCalled();
    const receipt = path.join(bundleDirectory(fixture), "bootstrap-receipt.json");
    expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toEqual(fixture.input.build);
    await expect(fs.readFile(archivePath)).resolves.toEqual(fixture.archive);
  });

  it("uses authenticated HTTP for a different archive without modifying prepared bytes", async () => {
    const prepared = await bundleFixture();
    const archivePath = await prepareLocalArchive(prepared);
    const requested = await bundleFixture({
      fixtureName: "new-build",
      workerSource: "export const changed = true;\n",
    });
    const served = await serve(requested.archive, requested.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.ensure({ input: requested.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(requested.input.build);

    expect(served.requests).toHaveBeenCalledOnce();
    await expect(fs.readdir(path.dirname(archivePath))).resolves.toEqual([
      path.basename(archivePath),
    ]);
    await expect(fs.readFile(archivePath)).resolves.toEqual(prepared.archive);
  });

  it.each(["cancel", "missing-stage"] as const)(
    "rejects %s during local acquisition without HTTP or admission",
    async (failure) => {
      const fixture = await bundleFixture();
      await prepareLocalArchive(fixture);
      const served = await serve(fixture.archive, fixture.input.archive.token);
      const { installer, ensure } = installation(fixture, served.gatewayUrl);
      const controller = new AbortController();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])) === "bundle.tgz" && args[1] === "wx") {
          if (failure === "missing-stage") {
            throw Object.assign(new Error("staging disappeared"), { code: "ENOENT" });
          }
          controller.abort(new Error("local acquisition cancelled"));
        }
        return await open(...args);
      });

      await expect(ensure({ signal: controller.signal })).rejects.toThrow(
        failure === "cancel" ? "local acquisition cancelled" : "staging disappeared",
      );

      expect(served.requests).not.toHaveBeenCalled();
      await expect(
        fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
      ).resolves.toEqual([]);
      await expect(
        installer.retain({ gatewayNamespace: fixture.input.gatewayNamespace, bundleHashes: [] }),
      ).resolves.toEqual({ deleted: 0, hasMore: false, generation: 0 });
    },
  );

  it.each(["corrupt", "wrong-length", "symlink", "hardlink", "directory"] as const)(
    "rejects a present %s prepared archive without HTTP or admission",
    async (kind) => {
      const fixture = await bundleFixture();
      const archivePath = await prepareLocalArchive(fixture);
      if (kind === "corrupt") {
        const corrupt = Buffer.from(fixture.archive);
        corrupt.writeUInt8(corrupt.readUInt8(0) ^ 1, 0);
        await fs.writeFile(archivePath, corrupt);
      } else if (kind === "wrong-length") {
        await fs.appendFile(archivePath, "extra");
      } else {
        await fs.rename(archivePath, `${archivePath}.original`);
        if (kind === "symlink") {
          await fs.symlink(`${archivePath}.original`, archivePath);
        } else if (kind === "hardlink") {
          await fs.link(`${archivePath}.original`, archivePath);
        } else {
          await fs.mkdir(archivePath);
        }
      }
      const served = await serve(fixture.archive, fixture.input.archive.token);
      const { ensure, inspect } = installation(fixture, served.gatewayUrl);

      await expect(ensure()).rejects.toThrow(
        kind === "corrupt"
          ? "worker bundle archive failed integrity validation"
          : "worker-bundle-install-failed",
      );

      expect(served.requests).not.toHaveBeenCalled();
      await expect(inspect()).resolves.toEqual({
        bundleHash: fixture.input.build.bundleHash,
        status: "missing",
      });
      await expect(fs.access(bundleDirectory(fixture))).rejects.toThrow();
    },
  );

  it("does not publish an HTTP bundle when cancellation arrives during receipt staging", async () => {
    const { fixture, served, ensure } = await setup();
    const controller = new AbortController();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("bootstrap-receipt.json") && args[1] === "wx") {
        controller.abort(new Error("installer cancelled"));
      }
      return handle;
    });

    await expect(ensure({ signal: controller.signal })).rejects.toThrow("installer cancelled");
    expect(served.requests).toHaveBeenCalledOnce();
    await expect(
      fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
    ).resolves.toEqual([]);
  });

  it("restores the prior destination when cancelled between local publication renames", async () => {
    const fixture = await bundleFixture();
    await prepareLocalArchive(fixture);
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const { ensure } = installation(fixture, served.gatewayUrl);
    const bundlesRoot = path.join(root, fixture.input.gatewayNamespace, "bundles");
    const destination = path.join(bundlesRoot, fixture.input.build.bundleHash);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "prior-install"), "preserved");
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      if (args[0] === destination && String(args[1]).includes(".previous-")) {
        controller.abort(new Error("publication cancelled"));
      }
    });

    await expect(ensure({ signal: controller.signal })).rejects.toThrow("publication cancelled");

    await expect(fs.readdir(bundlesRoot)).resolves.toEqual([fixture.input.build.bundleHash]);
    await expect(fs.readdir(destination)).resolves.toEqual(["prior-install"]);
    await expect(fs.readFile(path.join(destination, "prior-install"), "utf8")).resolves.toBe(
      "preserved",
    );
  });

  it("reports retained prior bytes when publication and rollback both fail", async () => {
    const fixture = await bundleFixture();
    await prepareLocalArchive(fixture);
    const installer = new NodeWorkerBundleInstaller({ root });
    const bundlesRoot = path.join(root, fixture.input.gatewayNamespace, "bundles");
    const destination = path.join(bundlesRoot, fixture.input.build.bundleHash);
    const priorBytes = Buffer.from("prior installation\n");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "prior-install"), priorBytes);
    const publicationFailure = new Error("staging publication failed");
    const rollbackFailure = new Error("prior installation rollback failed");
    const rename = fs.rename.bind(fs);
    let backup = "";
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (args[0] === destination) {
        await rename(...args);
        backup = String(args[1]);
        return;
      }
      if (args[1] === destination) {
        throw args[0] === backup ? rollbackFailure : publicationFailure;
      }
      await rename(...args);
    });

    const failure: unknown = await installer
      .ensure({ input: fixture.input, gatewayUrl: "ws://127.0.0.1:1" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeWorkerBundleInstallError);
    expect(failure).toHaveProperty(
      "message",
      `worker-bundle-install-failed: bundle transfer rollback failed; recover ${backup}`,
    );
    if (!(failure instanceof Error) || !(failure.cause instanceof Error)) {
      throw new Error("expected installer recovery failure", { cause: failure });
    }
    expect(failure.cause.cause).toBe(publicationFailure);
    expect(failure.cause).toHaveProperty("rollbackError", rollbackFailure);
    expect(backup.startsWith(`${destination}.previous-`)).toBe(true);
    await expect(fs.readdir(bundlesRoot)).resolves.toEqual([path.basename(backup)]);
    await expect(fs.readdir(backup)).resolves.toEqual(["prior-install"]);
    await expect(fs.readFile(path.join(backup, "prior-install"))).resolves.toEqual(priorBytes);
    await expect(fs.access(destination)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("does not renew retention when cancelled while validating an installed bundle", async () => {
    const { served, ensure, retain } = await setup();
    await ensure();
    const controller = new AbortController();
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (String(args[0]).endsWith("worker.mjs")) {
        controller.abort(new Error("cached install cancelled"));
      }
      return result;
    });

    await expect(ensure({ signal: controller.signal })).rejects.toThrow("cached install cancelled");

    expect(served.requests).toHaveBeenCalledOnce();
    await expect(retain()).resolves.toEqual({ deleted: 0, hasMore: false, generation: 1 });
  });

  it("rejects cancellation during final cleanup without renewing retention or removing published bytes", async () => {
    const { fixture, ensure, inspect, retain } = await setup();
    const controller = new AbortController();
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      await rm(...args);
      if (path.basename(String(args[0])).startsWith(".staging-")) {
        controller.abort(new Error("install cleanup cancelled"));
      }
    });

    await expect(ensure({ signal: controller.signal })).rejects.toThrow(
      "install cleanup cancelled",
    );

    await expect(inspect()).resolves.toEqual({
      bundleHash: fixture.input.build.bundleHash,
      status: "installed",
    });
    await expect(retain()).resolves.toEqual({ deleted: 0, hasMore: false, generation: 0 });
  });

  it("atomically installs, reuses, and cleans prior-hash crash staging", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed");
    const fixture = await bundleFixture({
      prewarmMarker,
      bundlePrewarm: 1,
      compileCacheDisabled: false,
    });
    const staleBundleHash = "f".repeat(64);
    const staleStaging = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      `.staging-${staleBundleHash}-crashed`,
    );
    await fs.mkdir(staleStaging, { recursive: true });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const { ensure } = installation(fixture, served.gatewayUrl, {
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: undefined },
    });

    await expect(ensure()).resolves.toEqual(fixture.input.build);
    await expect(ensure()).resolves.toEqual(fixture.input.build);

    expect(served.requests).toHaveBeenCalledOnce();
    await expect(fs.readFile(prewarmMarker, "utf8")).resolves.toBe("ready");
    await expect(fs.access(staleStaging)).rejects.toThrow();
    await expect(
      fs.readFile(path.join(bundleDirectory(fixture), "bootstrap-receipt.json"), "utf8"),
    ).resolves.toContain(fixture.input.build.bundleHash);
  });

  it("shares an in-flight prewarmed bundle check without sharing cancellation or later trust", async () => {
    const { fixture, served, installer, retain } = await setup({ bundlePrewarm: 1 });
    const install = { input: fixture.input, gatewayUrl: served.gatewayUrl };
    await installer.ensure(install);
    const bundleDir = bundleDirectory(fixture);
    const controller = new AbortController();
    const readdir = fs.readdir.bind(fs);
    let scans = 0;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === bundleDir) {
        scans++;
        controller.abort(new Error("one workspace cancelled"));
      }
      return await readdir(...args);
    });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        installer.ensure({ ...install, ...(index === 0 ? { signal: controller.signal } : {}) }),
      ),
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("one workspace cancelled"),
      }),
    });
    expect(results.slice(1)).toEqual(
      Array.from({ length: 11 }, () => ({ status: "fulfilled", value: fixture.input.build })),
    );
    expect(scans).toBe(1);
    await expect(retain()).resolves.toMatchObject({ generation: 12 });

    // A later request must hash the files again, including same-length edits.
    await fs.writeFile(path.join(bundleDir, "worker.mjs"), "export {};!");
    await installer.ensure(install);
    expect(served.requests).toHaveBeenCalledTimes(2);
    await expect(fs.readFile(path.join(bundleDir, "worker.mjs"), "utf8")).resolves.toBe(
      "export {};\n",
    );
  });

  it("validates again when retention separates overlapping install requests", async ({
    signal,
  }) => {
    const { fixture, served, installer, retain } = await setup({ bundlePrewarm: 1 });
    const install = { input: fixture.input, gatewayUrl: served.gatewayUrl };
    await installer.ensure(install);
    const bundleDir = bundleDirectory(fixture);
    const scanning = createDeferredCore();
    const release = createDeferredCore();
    const readdir = fs.readdir.bind(fs);
    let blocked = false;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === bundleDir && !blocked) {
        blocked = true;
        scanning.resolve();
        await release.promise;
      }
      return await readdir(...args);
    });
    const first = installer.ensure(install);
    try {
      await withinTest(scanning.promise, signal);
      const retained = retain([]);
      const second = installer.ensure(install);
      release.resolve();
      await expect(first).resolves.toEqual(fixture.input.build);
      await expect(retained).resolves.toMatchObject({ deleted: 1 });
      await expect(second).resolves.toEqual(fixture.input.build);
      expect(served.requests).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(path.join(bundleDir, "worker.mjs"), "utf8")).resolves.toBe(
        "export {};\n",
      );
    } finally {
      release.resolve();
      await first;
    }
  });

  it("prewarms bundles with managed cache behind a host compile-cache fence", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed-with-managed-cache");
    const fixture = await bundleFixture({
      prewarmMarker,
      bundlePrewarm: 1,
      compileCacheDisabled: false,
    });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const { ensure } = installation(fixture, served.gatewayUrl, {
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: "/tmp/ambient-host-compile-cache",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
        OPENCLAW_SERVICE_KIND: "node",
      },
    });

    await expect(ensure()).resolves.toEqual(fixture.input.build);
    await expect(fs.readFile(prewarmMarker, "utf8")).resolves.toBe("ready");
  });

  it("reuses a v1 install when Windows cannot retain Unix artifact modes", async () => {
    const { fixture, served, ensure } = await setup();
    const readStats = fs.lstat.bind(fs);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stats = await readStats(...args);
      if (stats.isFile()) {
        stats.mode = (Number(stats.mode) & ~0o777) | 0o666;
      }
      return stats;
    });

    try {
      await expect(ensure()).resolves.toEqual(fixture.input.build);
      await expect(ensure()).resolves.toEqual(fixture.input.build);
      expect(served.requests).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects the Cloudflare Access pair before a plaintext bundle transfer", async () => {
    const { served, ensure } = await setup();

    await expect(
      ensure({
        gatewayCloudflareAccess: {
          clientId: "cf-bundle-id",
          clientSecret: "cf-bundle-secret",
        },
      }),
    ).rejects.toThrow("worker-bundle-install-failed: Cloudflare Access credentials require HTTPS");

    expect(served.requests).not.toHaveBeenCalled();
  });

  it("prunes superseded bundle artifacts in bounded passes while retaining the latest install", async () => {
    const { fixture, ensure, retain } = await setup();
    await ensure();
    const bundlesRoot = path.join(root, fixture.input.gatewayNamespace, "bundles");
    const staleHashes = Array.from({ length: 18 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    ).filter((hash) => hash !== fixture.input.build.bundleHash);
    for (const hash of staleHashes) {
      await fs.mkdir(path.join(bundlesRoot, hash));
    }
    await fs.mkdir(path.join(bundlesRoot, `${"e".repeat(64)}.previous-crash`));
    await fs.mkdir(path.join(bundlesRoot, `.staging-${"d".repeat(64)}-crash`));
    await fs.mkdir(path.join(bundlesRoot, "operator-owned"));

    const first = await retain();
    expect(first).toEqual({ deleted: 16, hasMore: true, generation: 1 });
    let result = first;
    while (result.hasMore) {
      result = await retain();
    }

    await fs.access(path.join(bundlesRoot, fixture.input.build.bundleHash));
    await fs.access(path.join(bundlesRoot, "operator-owned"));
    for (const hash of staleHashes) {
      await expect(fs.access(path.join(bundlesRoot, hash))).rejects.toThrow();
    }
  });

  it("reinstalls when executable dependency material appears outside the bundle hash", async () => {
    const { fixture, served, ensure, inspect } = await setup({ packageShell: true });
    const bundleDir = bundleDirectory(fixture);
    const tamperedDependency = path.join(bundleDir, "node_modules", "tampered", "index.js");

    await ensure();
    await fs.mkdir(path.dirname(tamperedDependency), { recursive: true });
    await fs.writeFile(tamperedDependency, "export const trusted = false;\n");
    await expect(inspect()).resolves.toEqual({
      bundleHash: fixture.input.build.bundleHash,
      status: "missing",
    });
    await ensure();

    expect(served.requests).toHaveBeenCalledTimes(2);
    await expect(fs.access(tamperedDependency)).rejects.toThrow();
  });

  it("rejects an unexpected content length before publication", async () => {
    const fixture = await bundleFixture();
    const served = await serve(
      fixture.archive,
      fixture.input.archive.token,
      fixture.archive.byteLength + 1,
    );
    const { ensure } = installation(fixture, served.gatewayUrl);

    await expect(ensure()).rejects.toThrow("gateway returned an unexpected worker bundle length");
  });

  it("cancels prewarming and releases the namespace queue for the next install", async ({
    signal,
  }) => {
    const slowMarker = path.join(root, "slow-prewarm-started");
    const slow = await bundleFixture({
      fixtureName: "slow",
      bundlePrewarm: 1,
      workerSource: `${fixtureReceiptClientSource(receipts.endpoint)}\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(
        slowMarker,
      )}, String(process.pid));\nsendReceipt(${JSON.stringify(slowMarker)}, "ready");\nprocess.stdin.resume();\n`,
    });
    const fastMarker = path.join(root, "fast-prewarm-finished");
    const fast = await bundleFixture({
      fixtureName: "fast",
      bundlePrewarm: 1,
      prewarmMarker: fastMarker,
    });
    const fastRequested = createDeferredCore();
    server = http.createServer((req, res) => {
      if (req.url?.endsWith(fast.input.build.bundleHash)) {
        fastRequested.resolve();
      }
      const archive = req.url?.endsWith(slow.input.build.bundleHash) ? slow.archive : fast.archive;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(archive.byteLength),
      });
      res.end(archive);
    });
    const gatewayUrl = await listen(server);
    const installer = new NodeWorkerBundleInstaller({ root });
    const controller = new AbortController();
    const cleanupController = new AbortController();
    const testSignal = AbortSignal.any([signal, cleanupController.signal]);
    const first = installer.ensure({
      input: slow.input,
      gatewayUrl,
      signal: AbortSignal.any([controller.signal, testSignal]),
    });
    const installs = [first];
    let slowPid: number | undefined;
    cleanupPrewarming = async () => {
      cleanupController.abort();
      if (!slowPid) {
        const rawPid = await fs.readFile(slowMarker, "utf8").catch(() => undefined);
        slowPid = rawPid ? Number(rawPid) : undefined;
      }
      if (slowPid) {
        try {
          process.kill(slowPid, "SIGKILL");
        } catch {
          // The cancellation path already reaped the process.
        }
      }
      await Promise.allSettled(installs);
    };
    // Startup time is not the cancellation contract: hold the real child until
    // abort, and retain its PID so cleanup can terminate it after assertion failure.
    // The PID record precedes the receipt; child exit can overtake socket delivery.
    const settled = first.then(
      () => {
        if (!existsSync(slowMarker)) {
          throw new Error("prewarm finished before cancellation");
        }
      },
      (error: unknown) => {
        if (!existsSync(slowMarker)) {
          throw error;
        }
      },
    );
    await withinTest(Promise.race([receipts.waitFor(slowMarker, "ready"), settled]), signal);
    const value = await fs.readFile(slowMarker, "utf8");
    expect(value).toMatch(/^\d+$/u);
    slowPid = Number(value);
    testSignal.throwIfAborted();
    const second = installer.ensure({ input: fast.input, gatewayUrl, signal: testSignal });
    installs.push(second);

    controller.abort(new Error("launch fenced"));

    // Bound handoff from cancellation; acquisition precedes cold extraction and prewarm.
    await Promise.all([
      vi.waitFor(() => expect(fastRequested.promise).resolves.toBeUndefined(), { timeout: 750 }),
      expect(first).rejects.toThrow("launch fenced"),
    ]);
    await expect(second).resolves.toEqual(fast.input.build);
    await vi.waitFor(() => {
      expect(() => process.kill(slowPid!, 0)).toThrow();
    });
    await expect(fs.readFile(fastMarker, "utf8")).resolves.toBe("ready");
  });
});
