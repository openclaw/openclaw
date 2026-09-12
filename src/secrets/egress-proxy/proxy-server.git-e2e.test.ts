import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as proxyCa from "../../proxy-capture/ca.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

// Real-git behavior proof for the git trust bundle: git honors only
// GIT_SSL_CAINFO, so private-CA destinations on the bypass tunnel keep
// working exactly because the bundle merges operator CA sources, and
// intercepted destinations trust the minted proxy leaf. The pre-fix
// behavior (proxy-only bundle) is asserted to fail for comparison.

const run = { instanceId: "git-instance", runId: "git-run" };
const dirs = createTempDirTracker();
const audits: Array<{ kind: string; host: string; reason?: string }> = [];

function checked(binary: string, args: string[]): void {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000 });
  expect(result.status, `${binary} ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

type Origin = { server: Server; port: number };

/** Serves one bare repo over HTTPS using the dumb HTTP protocol. */
function startDumbGitOrigin(repoDir: string, tls: { key: Buffer; cert: Buffer }): Promise<Origin> {
  const root = path.resolve(repoDir);
  const server = createHttpsServer(tls, (request, response) => {
    let relative: string;
    try {
      relative = new URL(request.url ?? "/", "https://localhost").pathname.replace(/^\/+/, "");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    // text/plain on info/refs makes git fall back from smart HTTP to dumb.
    const body = fs.readFileSync(file);
    response.writeHead(200, {
      "Content-Type": relative === "info/refs" ? "text/plain" : "application/octet-stream",
      "Content-Length": body.length,
    });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({ server, port: address.port });
      } else {
        reject(new Error("dumb git origin did not bind"));
      }
    });
  });
}

const scrubbedEnvPrefixes = ["GIT_CONFIG_"] as const;
const scrubbedEnvKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GIT_TERMINAL_PROMPT",
] as const;

function cloneGit(
  url: string,
  env: Record<string, string>,
): Promise<{ status: number; stderr: string }> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !scrubbedEnvKeys.includes(key as (typeof scrubbedEnvKeys)[number]) &&
      !scrubbedEnvPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      base[key] = value;
    }
  }
  const cloneDir = dirs.make("openclaw-git-e2e-clone-");
  fs.rmSync(cloneDir, { recursive: true, force: true });
  const home = dirs.make("openclaw-git-e2e-home-");
  // Async spawn keeps the event loop live: origin and proxy servers in this
  // process must serve the clone while it runs.
  return new Promise((resolve) => {
    const child = spawn("git", ["clone", "--", url, cloneDir], {
      env: {
        ...base,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const deadline = setTimeout(() => child.kill(), 60_000);
    child.once("error", () => {
      clearTimeout(deadline);
      resolve({ status: 1, stderr: output });
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve({ status: code ?? 1, stderr: output });
    });
  });
}

describe("secret egress proxy git behavior", () => {
  let seedDir: string;
  let proxyCaLeaf: Awaited<ReturnType<typeof proxyCa.generateLocalProxyLeaf>>;
  let privateCa: { caPath: string; cert: Buffer; key: Buffer };
  let repoDir: string;
  const payload = "egress git proof\n";
  let privateOrigin: Origin;
  let proxyTrustedOrigin: Origin;
  let proxy: SecretEgressProxyHandle | undefined;

  beforeAll(async () => {
    // Shared proxy CA material; each proxy start copies it into its own dir.
    seedDir = dirs.make("openclaw-git-e2e-seed-");
    const ca = await proxyCa.ensureSecretEgressProxyCa(seedDir);
    proxyCaLeaf = await proxyCa.generateLocalProxyLeaf({
      certDir: seedDir,
      ca,
      hostname: "localhost",
    });

    // An operator private CA, fully independent of the proxy trust chain.
    const privateDir = dirs.make("openclaw-git-e2e-private-");
    const caKey = path.join(privateDir, "ca-key.pem");
    const caCert = path.join(privateDir, "ca.pem");
    const leafKey = path.join(privateDir, "leaf-key.pem");
    const csr = path.join(privateDir, "leaf.csr");
    const leafCert = path.join(privateDir, "leaf.pem");
    const ext = path.join(privateDir, "leaf.ext");
    fs.writeFileSync(ext, "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n");
    checked("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "7",
      "-subj",
      "/CN=OpenClaw E2E Private CA",
    ]);
    checked("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKey,
      "-subj",
      "/CN=localhost",
      "-out",
      csr,
    ]);
    checked("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      leafCert,
      "-days",
      "7",
      "-sha256",
      "-extfile",
      ext,
    ]);
    privateCa = {
      caPath: caCert,
      cert: fs.readFileSync(leafCert),
      key: fs.readFileSync(leafKey),
    };

    // One bare repo served by both origins.
    const seedRepo = dirs.make("openclaw-git-e2e-work-");
    checked("git", ["init", "-q", "--initial-branch=main", seedRepo]);
    fs.writeFileSync(path.join(seedRepo, "payload.txt"), payload);
    checked("git", ["-C", seedRepo, "add", "payload.txt"]);
    checked("git", [
      "-C",
      seedRepo,
      "-c",
      "user.name=OpenClaw E2E",
      "-c",
      "user.email=e2e@openclaw.invalid",
      "commit",
      "-q",
      "-m",
      "seed",
    ]);
    repoDir = dirs.make("openclaw-git-e2e-bare-");
    fs.rmSync(repoDir, { recursive: true, force: true });
    checked("git", ["clone", "-q", "--bare", seedRepo, repoDir]);
    checked("git", ["-C", repoDir, "update-server-info"]);

    privateOrigin = await startDumbGitOrigin(repoDir, {
      cert: privateCa.cert,
      key: privateCa.key,
    });
    proxyTrustedOrigin = await startDumbGitOrigin(repoDir, {
      cert: Buffer.from(proxyCaLeaf.cert),
      key: Buffer.from(proxyCaLeaf.key),
    });
  }, 60_000);

  afterAll(() => {
    privateOrigin.server.close();
    proxyTrustedOrigin.server.close();
    dirs.cleanup();
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    audits.length = 0;
    vi.unstubAllEnvs();
  });

  function seededCaDir(): string {
    const caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-e2e-ca-"));
    for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
      fs.copyFileSync(path.join(seedDir, file), path.join(caDir, file));
    }
    return caDir;
  }

  /** Starts the bypass proxy with the operator's private CA merged in. */
  async function startBypassProxyWithOperatorTrust(): Promise<void> {
    const gitConfig = path.join(seedDir, "operator-gitconfig");
    fs.writeFileSync(gitConfig, `[http]\n\tsslCAInfo = ${privateCa.caPath}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
    vi.stubEnv("SSL_CERT_FILE", undefined);
    vi.stubEnv("GIT_SSL_CAINFO", undefined);
    proxy = await startSecretEgressProxyServer({
      caDir: seededCaDir(),
      bypassHosts: ["localhost"],
      onAudit: (event) => audits.push(event),
    });
  }

  it(
    "clones a bypassed private-CA git origin through the merged git trust bundle",
    { timeout: 90_000 },
    async () => {
      await startBypassProxyWithOperatorTrust();
      const env = proxy!.registerRun(run, []);
      expect(env.GIT_SSL_CAINFO).toContain("git-trust-bundle.pem");
      const result = await cloneGit(`https://localhost:${privateOrigin.port}`, env);
      expect(result.status).toBe(0);
      expect(audits.some((event) => event.kind === "forwarded" && event.reason === "bypass")).toBe(
        true,
      );
    },
  );

  it(
    "fails the same bypass clone when git trusts only the proxy bundle (pre-fix behavior)",
    { timeout: 90_000 },
    async () => {
      await startBypassProxyWithOperatorTrust();
      const env = proxy!.registerRun(run, []);
      const preFix = { ...env, GIT_SSL_CAINFO: env.NODE_EXTRA_CA_CERTS! };
      const result = await cloneGit(`https://localhost:${privateOrigin.port}`, preFix);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/SSL|certificate/i);
    },
  );

  it("clones an intercepted git origin with proxy-issued trust", { timeout: 90_000 }, async () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
    vi.stubEnv("SSL_CERT_FILE", undefined);
    vi.stubEnv("GIT_SSL_CAINFO", undefined);
    proxy = await startSecretEgressProxyServer({
      caDir: seededCaDir(),
      allowedHosts: ["localhost"],
      onAudit: (event) => audits.push(event),
    });
    const env = proxy.registerRun(run, []);
    const result = await cloneGit(`https://localhost:${proxyTrustedOrigin.port}`, env);
    expect(result.status).toBe(0);
    expect(audits.some((event) => event.kind === "forwarded" && event.host === "localhost")).toBe(
      true,
    );
    expect(audits.some((event) => event.reason === "bypass")).toBe(false);
  });
});
