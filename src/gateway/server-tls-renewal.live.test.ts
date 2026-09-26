import fs from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { loadGatewayTlsServerRuntime } from "../infra/tls/gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { startGatewayTlsRenewal } from "./server-tls-renewal.js";

const describeLive = process.env.OPENCLAW_LIVE_TEST === "1" ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Release-tier OS proof: waits on the real TLS owner, with no test polling or sleeps.
describeLive("TLS observation on the real filesystem", () => {
  it("renews edits, deletion recovery, atomic replacement and projected-secret links, then closes", async () => {
    const directory = await fs.realpath(tempDirs.make("openclaw-tls-observation-"));
    const first = path.join(directory, "generation-one");
    const second = path.join(directory, "generation-two");
    await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
    const observed = path.join(directory, "..data");
    await fs.symlink(first, observed, process.platform === "win32" ? "junction" : "dir");
    const certPath = path.join(observed, "cert.pem");
    const keyPath = path.join(observed, "key.pem");
    await Promise.all([
      fs.writeFile(path.join(first, "cert.pem"), TEST_TLS_CERT_PEM),
      fs.writeFile(path.join(first, "key.pem"), TEST_TLS_KEY_PEM),
      fs.writeFile(path.join(second, "cert.pem"), `${TEST_TLS_CERT_PEM}\n\n\n`),
      fs.writeFile(path.join(second, "key.pem"), TEST_TLS_KEY_PEM),
    ]);
    const runtime = await loadGatewayTlsServerRuntime({
      enabled: true,
      autoGenerate: false,
      certPath,
      keyPath,
    });
    if (!runtime.enabled || !runtime.tlsOptions) {
      throw new Error(runtime.error ?? "Synthetic TLS material was rejected");
    }
    // The initial owner read removes this valid CA, providing a readiness witness.
    runtime.tlsOptions.ca = TEST_TLS_CERT_PEM;
    const server = createServer(runtime.tlsOptions);
    let renewed = createDeferredCore();
    const rejected = createDeferredCore();
    const owner = startGatewayTlsRenewal({
      runtime,
      servers: [server],
      enabled: true,
      isClosing: () => false,
      onRenewed: async () => renewed.resolve(),
      log: {
        info: () => {},
        warn: (message) => {
          if (message.startsWith("gateway TLS renewal failed;")) {
            rejected.resolve();
          }
        },
      },
    });
    if (!owner) {
      throw new Error("TLS renewal was not started");
    }
    try {
      await renewed.promise;
      renewed = createDeferredCore();
      await fs.appendFile(path.join(first, "cert.pem"), "\n");
      await renewed.promise;
      expect(runtime.tlsOptions.cert).toBe(`${TEST_TLS_CERT_PEM}\n`);

      await fs.unlink(path.join(first, "cert.pem"));
      await rejected.promise;
      expect(runtime.tlsOptions.cert).toBe(`${TEST_TLS_CERT_PEM}\n`);

      renewed = createDeferredCore();
      const replacement = path.join(first, "replacement.pem");
      await fs.writeFile(replacement, `${TEST_TLS_CERT_PEM}\n\n`);
      await fs.rename(replacement, path.join(first, "cert.pem"));
      await renewed.promise;
      expect(runtime.tlsOptions.cert).toBe(`${TEST_TLS_CERT_PEM}\n\n`);

      renewed = createDeferredCore();
      const nextLink = path.join(directory, "next-data");
      await fs.symlink(second, nextLink, process.platform === "win32" ? "junction" : "dir");
      if (process.platform === "win32") {
        await fs.unlink(observed);
      }
      await fs.rename(nextLink, observed);
      await renewed.promise;
      expect(runtime.tlsOptions.cert).toBe(`${TEST_TLS_CERT_PEM}\n\n\n`);
    } finally {
      await owner.stop();
    }
  }, 15_000);
});
