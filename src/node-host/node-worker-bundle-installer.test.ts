import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as timers from "node:timers/promises";
import { pathToFileURL } from "node:url";
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
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    }
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

  const bundlesDirectory = (fixture: BundleFixture) =>
    path.join(root, fixture.input.gatewayNamespace, "bundles");
  const bundleDirectory = (fixture: BundleFixture) =>
    path.join(bundlesDirectory(fixture), fixture.input.build.bundleHash);
  const status = (fixture: BundleFixture, state: "missing" | "installed") => ({
    bundleHash: fixture.input.build.bundleHash,
    status: state,
  });

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
      prefetch: (signal?: AbortSignal) =>
        installer.ensure({ input: { ...fixture.input, prefetch: 1 }, gatewayUrl, signal }),
      inspect: () => installer.inspect({ gatewayNamespace, bundleHash: build.bundleHash }),
      retain: (bundleHashes = [build.bundleHash]) =>
        installer.retain({ gatewayNamespace, bundleHashes }),
    };
  }

  async function serve(
    fixture: BundleFixture,
    respond?: http.RequestListener,
    declaredBytes = fixture.archive.byteLength,
  ) {
    const { archive, input } = fixture;
    const requests = vi.fn();
    server = http.createServer((req, res) => {
      requests(req.url, req.headers);
      if (req.headers.authorization !== `Bearer ${input.archive.token}`) {
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
    const served = await serve(fixture);
    return { fixture, served, ...installation(fixture, served.gatewayUrl) };
  }

  function observeDirectory(directory: string, onRead: () => void | Promise<void>) {
    const readdir = fs.readdir.bind(fs);
    return vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === directory) {
        const pending = onRead();
        if (pending) {
          await pending;
        }
      }
      return await readdir(...args);
    });
  }

  async function expectText(file: string, text: string) {
    await expect(fs.readFile(file, "utf8")).resolves.toBe(text);
  }

  it("stages a verified archive without activation and reuses it for the first session", async () => {
    const { fixture, served, ensure, inspect, prefetch } = await setup();

    await prefetch();
    await prefetch();

    expect(served.requests).toHaveBeenCalledTimes(1);
    await expect(fs.readdir(bundleDirectory(fixture))).resolves.toEqual(["bundle.tgz"]);
    await expect(inspect()).resolves.toMatchObject({ status: "missing" });
    await expect(ensure()).resolves.toEqual(fixture.input.build);
    expect(served.requests).toHaveBeenCalledTimes(1);
    await expect(inspect()).resolves.toMatchObject({ status: "installed" });
    expect(existsSync(path.join(bundleDirectory(fixture), "bundle.tgz"))).toBe(false);
  });

  it.each(["session", "disconnect"])("cancels unfinished prefetch on %s", async (reason) => {
    const fixture = await bundleFixture();
    const started = createDeferredCore();
    let requests = 0;
    const served = await serve(fixture, (_req, res) => {
      res.writeHead(200, { "content-length": fixture.archive.length });
      if (++requests === 1) {
        res.flushHeaders();
        started.resolve();
      } else {
        res.end(fixture.archive);
      }
    });
    const { ensure, inspect, prefetch } = installation(fixture, served.gatewayUrl);
    const connection = new AbortController();
    const prefetched = prefetch(connection.signal);
    const interrupted = expect(prefetched).rejects.toThrow(
      reason === "session" ? "yielded to a session" : "node disconnected",
    );
    await started.promise;
    if (reason === "disconnect") {
      connection.abort(new Error("node disconnected"));
    }

    await expect(ensure()).resolves.toEqual(fixture.input.build);
    await interrupted;

    expect(served.requests).toHaveBeenCalledTimes(2);
    await expect(inspect()).resolves.toMatchObject({ status: "installed" });
  });

  it("does not enqueue prefetch behind a foreground acquisition", async () => {
    const fixture = await bundleFixture();
    const started = createDeferredCore<http.ServerResponse>();
    const served = await serve(fixture, (_req, res) => {
      started.resolve(res);
    });
    const { ensure, prefetch } = installation(fixture, served.gatewayUrl);
    const foreground = ensure();
    const response = await started.promise;

    await prefetch();
    response.writeHead(200, { "content-length": fixture.archive.length }).end(fixture.archive);
    await foreground;

    expect(served.requests).toHaveBeenCalledTimes(1);
  });

  it.each(["failed download", "corrupt staged archive"])(
    "falls back to session acquisition after %s",
    async (failure) => {
      const fixture = await bundleFixture();
      let prefetching = true;
      const served = await serve(fixture, (_req, res) => {
        res.writeHead(200, { "content-length": fixture.archive.length });
        res.end(
          prefetching && failure === "failed download"
            ? Buffer.alloc(fixture.archive.length)
            : fixture.archive,
        );
      });
      const { ensure, inspect, prefetch } = installation(fixture, served.gatewayUrl);
      const prefetched = prefetch();
      if (failure === "failed download") {
        await expect(prefetched).rejects.toThrow("integrity validation");
      } else {
        await prefetched;
        await fs.writeFile(path.join(bundleDirectory(fixture), "bundle.tgz"), "corrupt");
      }
      prefetching = false;

      await expect(ensure()).resolves.toEqual(fixture.input.build);

      expect(served.requests).toHaveBeenCalledTimes(2);
      await expect(inspect()).resolves.toMatchObject({ status: "installed" });
    },
  );

  it("prunes unretained prefetched archives through normal bundle retention", async () => {
    const { fixture, retain, prefetch } = await setup();
    await prefetch();

    await expect(retain([])).resolves.toMatchObject({ deleted: 1, hasMore: false });

    expect(existsSync(bundleDirectory(fixture))).toBe(false);
  });

  it("resumes an authenticated download across repeated interruptions", async () => {
    const interruptions = 4;
    const fixture = await bundleFixture();
    const partialBytes = Math.floor(fixture.archive.length / (interruptions + 1));
    vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
    const interrupt = interruptAfterStagingWrite();
    let attempts = 0;
    const served = await serve(fixture, (req, res) => {
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
    });
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
    await expect(fs.readdir(bundlesDirectory(fixture))).resolves.toEqual([
      fixture.input.build.bundleHash,
    ]);
  });

  it.each(["no bytes", "partial", "ignored range"])(
    "stops after three no-progress failures and removes staging (%s)",
    async (mode) => {
      const fixture = await bundleFixture();
      const partialBytes = Math.floor(fixture.archive.length / 2);
      vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
      const interrupt = interruptAfterStagingWrite();
      let requests = 0;
      const served = await serve(fixture, (_req, res) => {
        requests++;
        if ((mode === "partial" && requests === 1) || mode === "ignored range") {
          res.writeHead(200, { "content-length": fixture.archive.length });
          interrupt(res, fixture.archive.subarray(0, partialBytes));
        } else {
          res.destroy();
        }
      });
      const { ensure } = installation(fixture, served.gatewayUrl);

      await expect(ensure()).rejects.toThrow("3 consecutive no-progress failures");

      expect(served.requests.mock.calls.map(([, headers]) => headers.range)).toEqual(
        mode !== "no bytes"
          ? [undefined, ...Array<string>(3).fill(`bytes=${partialBytes}-`)]
          : [undefined, undefined, undefined],
      );
      await expect(fs.readdir(bundlesDirectory(fixture))).resolves.toEqual([]);
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

  async function localSetup() {
    const fixture = await bundleFixture();
    const archivePath = await prepareLocalArchive(fixture);
    const served = await serve(fixture);
    return { fixture, archivePath, served, ...installation(fixture, served.gatewayUrl) };
  }

  it("cancels retry backoff without another request and removes staging", async () => {
    const fixture = await bundleFixture();
    const controller = new AbortController();
    vi.mocked(timers.setTimeout).mockImplementation(async (_ms, _value, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error("download cancelled"));
      throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    });
    const served = await serve(fixture, (_req, res) => res.destroy());
    const { ensure } = installation(fixture, served.gatewayUrl);

    await expect(ensure({ signal: controller.signal })).rejects.toThrow("download cancelled");
    expect(served.requests).toHaveBeenCalledOnce();
    await expect(fs.readdir(bundlesDirectory(fixture))).resolves.toEqual([]);
  });

  it.each(["missing", "malformed"] as const)(
    "quietly repairs a %s bundle cache receipt",
    async (receiptState) => {
      const { fixture, archivePath, served, ensure, inspect } = await localSetup();
      const destination = bundleDirectory(fixture);
      if (receiptState === "malformed") {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, "bootstrap-receipt.json"), "{invalid");
      }
      await expect(inspect()).resolves.toEqual(status(fixture, "missing"));
      await expect(ensure()).resolves.toEqual(fixture.input.build);
      await expect(inspect()).resolves.toEqual(status(fixture, "installed"));
      expect(served.requests).not.toHaveBeenCalled();
      expect(
        JSON.parse(await fs.readFile(path.join(destination, "bootstrap-receipt.json"), "utf8")),
      ).toEqual(fixture.input.build);
      await expect(fs.readFile(archivePath)).resolves.toEqual(fixture.archive);
      expect(bundleWarnings).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["receipt", "EACCES"],
    ["manifest", "EIO"],
  ] as const)(
    "reports %s %s failures once per operation while preserving cache repair",
    async (phase, errorCode) => {
      const { fixture, ensure, inspect } = await localSetup();
      await ensure();
      const destination = bundleDirectory(fixture);
      const failure = Object.assign(new Error("synthetic private message and tool content"), {
        code: errorCode,
        request: { body: "synthetic private request" },
      });
      let failuresRemaining = 2;
      const readFile = fs.readFile.bind(fs);
      const failRead = () => {
        if (failuresRemaining > 0) {
          failuresRemaining--;
          throw failure;
        }
      };
      const readFailure =
        phase === "receipt"
          ? vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
              if (args[0] === path.join(destination, "bootstrap-receipt.json")) {
                failRead();
              }
              return await readFile(...args);
            })
          : observeDirectory(destination, failRead);
      const warning = expect.stringContaining(
        `Worker bundle ${phase === "receipt" ? "receipt" : "cache"} read failed`,
      );
      await expect(inspect()).resolves.toEqual(status(fixture, "missing"));
      expect(bundleWarnings).toHaveBeenCalledExactlyOnceWith(warning, { errorCode });
      bundleWarnings.mockClear();
      await expect(ensure()).resolves.toEqual(fixture.input.build);
      expect(bundleWarnings).toHaveBeenCalledExactlyOnceWith(warning, { errorCode });
      expect(failuresRemaining).toBe(0);
      readFailure.mockRestore();
      await expect(inspect()).resolves.toEqual(status(fixture, "installed"));
      expect(bundleWarnings).toHaveBeenCalledExactlyOnceWith(warning, { errorCode });
    },
  );

  it("uses authenticated HTTP for a different archive without modifying prepared bytes", async () => {
    const prepared = await bundleFixture();
    const archivePath = await prepareLocalArchive(prepared);
    const requested = await bundleFixture({
      fixtureName: "new-build",
      workerSource: "export const changed = true;\n",
    });
    const served = await serve(requested);
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
      const { fixture, served, ensure, retain } = await localSetup();
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
      await expect(fs.readdir(bundlesDirectory(fixture))).resolves.toEqual([]);
      await expect(retain([])).resolves.toEqual({ deleted: 0, hasMore: false, generation: 0 });
    },
  );

  it.each(["corrupt", "wrong-length", "symlink", "hardlink", "directory"] as const)(
    "rejects a present %s prepared archive without HTTP or admission",
    async (kind) => {
      const { fixture, archivePath, served, ensure, inspect } = await localSetup();
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
      await expect(ensure()).rejects.toThrow(
        kind === "corrupt"
          ? "worker bundle archive failed integrity validation"
          : "worker-bundle-install-failed",
      );

      expect(served.requests).not.toHaveBeenCalled();
      await expect(inspect()).resolves.toEqual(status(fixture, "missing"));
      await expect(fs.access(bundleDirectory(fixture))).rejects.toThrow();
    },
  );

  it("restores the prior destination when cancelled between local publication renames", async () => {
    const { fixture, ensure } = await localSetup();
    const bundlesRoot = bundlesDirectory(fixture);
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
    await expectText(path.join(destination, "prior-install"), "preserved");
  });

  it("reports retained prior bytes when publication and rollback both fail", async () => {
    const { fixture, ensure } = await localSetup();
    const bundlesRoot = bundlesDirectory(fixture);
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

    const failure: unknown = await ensure().catch((error: unknown) => error);
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

  it.each(["receipt", "validation", "cleanup"])(
    "preserves publication and retention boundaries when cancelled during %s",
    async (phase) => {
      const { fixture, served, ensure, inspect, retain } = await setup();
      if (phase === "validation") {
        await ensure();
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("installer cancelled"));
      if (phase === "receipt") {
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith("bootstrap-receipt.json") && args[1] === "wx") {
            cancel();
          }
          return handle;
        });
      } else if (phase === "validation") {
        const stat = fs.stat.bind(fs);
        vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
          const result = await stat(...args);
          if (String(args[0]).endsWith("worker.mjs")) {
            cancel();
          }
          return result;
        });
      } else {
        const rm = fs.rm.bind(fs);
        vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          await rm(...args);
          if (path.basename(String(args[0])).startsWith(".staging-")) {
            cancel();
          }
        });
      }
      await expect(ensure({ signal: controller.signal })).rejects.toThrow("installer cancelled");
      expect(served.requests).toHaveBeenCalledOnce();
      if (phase === "receipt") {
        await expect(fs.readdir(bundlesDirectory(fixture))).resolves.toEqual([]);
      } else if (phase === "cleanup") {
        await expect(inspect()).resolves.toEqual(status(fixture, "installed"));
      }
      if (phase !== "receipt") {
        await expect(retain()).resolves.toEqual({
          deleted: 0,
          hasMore: false,
          generation: phase === "validation" ? 1 : 0,
        });
      }
    },
  );

  it("atomically installs and reuses with managed prewarming and cleans prior-hash crash staging", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed");
    const fixture = await bundleFixture({
      prewarmMarker,
      bundlePrewarm: 1,
      compileCacheDisabled: false,
    });
    const staleBundleHash = "f".repeat(64);
    const staleStaging = path.join(
      bundlesDirectory(fixture),
      `.staging-${staleBundleHash}-crashed`,
    );
    await fs.mkdir(staleStaging, { recursive: true });
    const served = await serve(fixture);
    const { ensure } = installation(fixture, served.gatewayUrl, {
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: "/tmp/ambient-host-compile-cache",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_PROFILE: "work",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node.work",
        OPENCLAW_SERVICE_KIND: "node",
      },
    });

    await expect(ensure()).resolves.toEqual(fixture.input.build);
    await expect(ensure()).resolves.toEqual(fixture.input.build);

    expect(served.requests).toHaveBeenCalledOnce();
    await expectText(prewarmMarker, "ready");
    await expect(fs.access(staleStaging)).rejects.toThrow();
    await expect(
      fs.readFile(path.join(bundleDirectory(fixture), "bootstrap-receipt.json"), "utf8"),
    ).resolves.toContain(fixture.input.build.bundleHash);
  });

  it("prewarms a downloaded worker with the standalone executable's generic runtime", async () => {
    const marker = path.join(root, "generic-worker-prewarmed");
    const fixture = await bundleFixture({
      bundlePrewarm: 1,
      workerSource: `import fs from "node:fs";
if (process.env.BUN_BE_BUN !== "1") throw new Error("downloaded worker needs generic runtime");
fs.writeFileSync(${JSON.stringify(marker)}, process.execPath);
`,
    });
    const served = await serve(fixture);
    vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(root).href);
    try {
      await expect(installation(fixture, served.gatewayUrl).ensure()).resolves.toEqual(
        fixture.input.build,
      );
      await expectText(marker, process.execPath);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares an in-flight prewarmed bundle check without sharing cancellation or later trust", async () => {
    const { fixture, served, ensure, retain } = await setup({ bundlePrewarm: 1 });
    await ensure();
    const bundleDir = bundleDirectory(fixture);
    const controller = new AbortController();
    let scans = 0;
    observeDirectory(bundleDir, () => {
      scans++;
      controller.abort(new Error("one workspace cancelled"));
    });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        ensure(index === 0 ? { signal: controller.signal } : {}),
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
    await ensure();
    expect(served.requests).toHaveBeenCalledTimes(2);
    await expectText(path.join(bundleDir, "worker.mjs"), "export {};\n");
  });

  it("validates again when retention separates overlapping install requests", async ({
    signal,
  }) => {
    const { fixture, served, ensure, retain } = await setup({ bundlePrewarm: 1 });
    await ensure();
    const bundleDir = bundleDirectory(fixture);
    const scanning = createDeferredCore();
    const release = createDeferredCore();
    let blocked = false;
    observeDirectory(bundleDir, async () => {
      if (!blocked) {
        blocked = true;
        scanning.resolve();
        await release.promise;
      }
    });
    const first = ensure();
    try {
      await withinTest(scanning.promise, signal);
      const retained = retain([]);
      const second = ensure();
      release.resolve();
      await expect(first).resolves.toEqual(fixture.input.build);
      await expect(retained).resolves.toMatchObject({ deleted: 1 });
      await expect(second).resolves.toEqual(fixture.input.build);
      expect(served.requests).toHaveBeenCalledTimes(2);
      await expectText(path.join(bundleDir, "worker.mjs"), "export {};\n");
    } finally {
      release.resolve();
      await first;
    }
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

    await expect(ensure()).resolves.toEqual(fixture.input.build);
    await expect(ensure()).resolves.toEqual(fixture.input.build);
    expect(served.requests).toHaveBeenCalledOnce();
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
    const bundlesRoot = bundlesDirectory(fixture);
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

    expect((await fs.readdir(bundlesRoot)).toSorted()).toEqual(
      [fixture.input.build.bundleHash, "operator-owned"].toSorted(),
    );
  });

  it("reinstalls when executable dependency material appears outside the bundle hash", async () => {
    const { fixture, served, ensure, inspect } = await setup({ packageShell: true });
    const bundleDir = bundleDirectory(fixture);
    const tamperedDependency = path.join(bundleDir, "node_modules", "tampered", "index.js");

    await ensure();
    await fs.mkdir(path.dirname(tamperedDependency), { recursive: true });
    await fs.writeFile(tamperedDependency, "export const trusted = false;\n");
    await expect(inspect()).resolves.toEqual(status(fixture, "missing"));
    await ensure();

    expect(served.requests).toHaveBeenCalledTimes(2);
    await expect(fs.access(tamperedDependency)).rejects.toThrow();
  });

  it("rejects an unexpected content length before publication", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture, undefined, fixture.archive.byteLength + 1);
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
    const requireStarted = (error: unknown = new Error("prewarm finished before cancellation")) => {
      if (!existsSync(slowMarker)) {
        throw error;
      }
    };
    const settled = first.then(() => requireStarted(), requireStarted);
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
    await expectText(fastMarker, "ready");
  });
});
