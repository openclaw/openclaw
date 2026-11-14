import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type {
  WorkerLiveEventParams,
  WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { runExec } from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";

type CredentialProofGateway = {
  inferenceRequests: WorkerInferenceStartParams[];
  transcriptRequests: WorkerTranscriptCommitParams[];
  liveEventRequests: WorkerLiveEventParams[];
};

type CredentialProofOptions = {
  inferencePlans: ["tool", "text"];
  execCommand: string;
};

type CredentialProofDependencies = {
  setup: (options: CredentialProofOptions) => Promise<{
    gateway: CredentialProofGateway;
    workspaceDir: string;
    launch: WorkerLaunchDescriptor;
  }>;
};

type CloseableServer = {
  listening: boolean;
  close: (callback: (error?: Error) => void) => unknown;
};

async function closeServer(server: CloseableServer | undefined) {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runWorkerCli(launch: WorkerLaunchDescriptor) {
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "src/entry.ts", "worker"],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-4_096);
  });
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
  try {
    child.stdin.end(`${JSON.stringify(launch)}\n`);
    const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    if (code !== 0) {
      throw new Error(
        `openclaw worker CLI exited with code ${code ?? "unknown"} (${signal ?? "no signal"})`,
      );
    }
    const result = JSON.parse(stdout.trim()) as { status?: unknown };
    expect(result.status).toBe("completed");
  } finally {
    clearTimeout(timeout);
  }
}

/** Exercise the shipped worker CLI with real Git HTTPS requests and ephemeral fixture credentials. */
export async function runManagedWorkerGitIdentityProof({ setup }: CredentialProofDependencies) {
  const proofDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-credential-proof-"));
  const certPath = path.join(proofDir, "server-cert.pem");
  const keyPath = path.join(proofDir, "server-key.pem");
  const forgejoHelperPath = path.join(proofDir, "forgejo-credential-helper");
  const globalConfigPath = path.join(proofDir, "gitconfig");
  const githubToken = randomBytes(32).toString("hex");
  const githubLogin = `worker-${randomBytes(6).toString("hex")}`;
  const forgejoUsername = `forgejo-${randomBytes(6).toString("hex")}`;
  const forgejoPassword = randomBytes(32).toString("hex");
  const binding = {
    token: githubToken,
    login: githubLogin,
    branch: "openclaw/session-fixture",
    remoteUrl: "https://github.com/openclaw/worker-fixture.git",
  };
  const authenticatedHosts = new Set<string>();
  const proxyTargets = new Map<string, number>();
  const allowedProxyTargets = new Set(["github.com:443", "forgejo.example:443"]);
  const expectedCredentials = new Map([
    ["github.com", { username: "", password: binding.token }],
    ["forgejo.example", { username: forgejoUsername, password: forgejoPassword }],
  ]);
  let tlsServer: ReturnType<typeof createHttpsServer> | undefined;
  let proxyServer: ReturnType<typeof createServer> | undefined;
  try {
    await runExec(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=github.com",
        "-addext",
        "subjectAltName=DNS:github.com,DNS:forgejo.example",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { timeoutMs: 15_000, maxBuffer: 4_096, logOutput: false },
    );
    await writeFile(
      forgejoHelperPath,
      [
        "#!/bin/sh",
        'case "${1:-get}" in',
        `  get) printf 'username=%s\\npassword=%s\\n\\n' "$OPENCLAW_FORGEJO_USERNAME" "$OPENCLAW_FORGEJO_PASSWORD" ;;`,
        "  store|erase) cat >/dev/null ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(forgejoHelperPath, 0o700);
    const certificate = await readFile(certPath);
    const privateKey = await readFile(keyPath);
    tlsServer = createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
      const host = (request.headers.host ?? "").toLowerCase().split(":")[0] ?? "";
      const expected = expectedCredentials.get(host);
      const authorization = request.headers.authorization ?? "";
      const decoded = authorization.startsWith("Basic ")
        ? Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8")
        : "";
      const separator = decoded.indexOf(":");
      const username = separator >= 0 ? decoded.slice(0, separator) : "";
      const password = separator >= 0 ? decoded.slice(separator + 1) : "";
      const authenticated =
        expected !== undefined &&
        password === expected.password &&
        (host === "github.com" || username === expected.username);
      if (!authenticated) {
        response.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="worker credential proof"',
          Connection: "close",
        });
        response.end();
        return;
      }
      authenticatedHosts.add(host);
      const serviceLine = "# service=git-upload-pack\n";
      const advertisement = Buffer.from(
        `${(Buffer.byteLength(serviceLine) + 4).toString(16).padStart(4, "0")}${serviceLine}00000000`,
        "ascii",
      );
      response.writeHead(200, {
        "Content-Type": "application/x-git-upload-pack-advertisement",
        "Content-Length": advertisement.length,
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      response.end(advertisement);
    });
    const tlsReady = once(tlsServer, "listening");
    tlsServer.listen(0, "127.0.0.1");
    await tlsReady;
    const tlsAddress = tlsServer.address();
    if (!tlsAddress || typeof tlsAddress === "string") {
      throw new Error("credential proof TLS server did not bind to loopback");
    }

    proxyServer = createServer();
    proxyServer.on("connect", (request, clientSocket, head) => {
      const target = (request.url ?? "").toLowerCase();
      proxyTargets.set(target, (proxyTargets.get(target) ?? 0) + 1);
      if (!allowedProxyTargets.has(target)) {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connectTcp(tlsAddress.port, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
    const proxyReady = once(proxyServer, "listening");
    proxyServer.listen(0, "127.0.0.1");
    await proxyReady;
    const proxyAddress = proxyServer.address();
    if (!proxyAddress || typeof proxyAddress === "string") {
      throw new Error("credential proof proxy did not bind to loopback");
    }
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    await writeFile(
      globalConfigPath,
      [
        "[http]",
        `\tproxy = ${proxyUrl}`,
        `\tsslCAInfo = ${certPath}`,
        "[credential]",
        `\thelper = ${forgejoHelperPath}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const configPath = path.join(proofDir, "openclaw.json");
    await writeFile(configPath, "{}\n", "utf8");

    const { gateway, workspaceDir, launch } = await setup({
      inferencePlans: ["tool", "text"],
      execCommand: [
        'printf "%s" "$GH_TOKEN" | if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d " " -f1',
        'printf "github-token=%s\\n" "$GITHUB_TOKEN"',
        'printf "helpers-start\\n"',
        "git config --get-all credential.https://github.com.helper",
        'printf "helpers-end\\n"',
        "git config --show-scope --get-all credential.https://github.com.helper",
        "git symbolic-ref HEAD",
        "git remote get-url origin",
        'printf "profile=%s\\n" "$GH_CONFIG_DIR"',
        'node -e \'const fs=require("node:fs");const p=require("node:path");const d=process.env.GH_CONFIG_DIR;if((fs.statSync(d).mode&0o777)!==0o700||(fs.statSync(p.join(d,"hosts.yml")).mode&0o777)!==0o600)process.exit(1);console.log("profile-active: mode=700, hosts.yml=600")\'',
        'grep -Fq "$WORKER_PROOF_GITHUB_LOGIN" "$GH_CONFIG_DIR/hosts.yml" && printf "profile-identity=matched\\n"',
        'NO_PROXY= no_proxy= GIT_TERMINAL_PROMPT=0 git -c protocol.version=0 -c http.connectTimeout=2 -c http.lowSpeedLimit=1 -c http.lowSpeedTime=2 -c http.proxy="$WORKER_PROOF_PROXY" -c http.sslCAInfo="$WORKER_PROOF_CA" ls-remote https://forgejo.example/team/project.git >/dev/null && printf "forgejo-authenticated\\n"',
        'NO_PROXY= no_proxy= GIT_TERMINAL_PROMPT=0 git -c protocol.version=0 -c http.connectTimeout=2 -c http.lowSpeedLimit=1 -c http.lowSpeedTime=2 -c http.proxy="$WORKER_PROOF_PROXY" -c http.sslCAInfo="$WORKER_PROOF_CA" ls-remote https://github.com/openclaw/worker-fixture.git >/dev/null && printf "github-authenticated\\n"',
      ].join("; "),
    });
    launch.assignment.github = binding;
    const git = async (args: string[]) =>
      await runExec("git", ["-C", workspaceDir, ...args], {
        timeoutMs: 10_000,
        maxBuffer: 4_096,
        logOutput: false,
      });
    await git(["init", "--quiet", "--initial-branch=openclaw-worker"]);
    await git([
      "-c",
      "user.name=Worker Fixture",
      "-c",
      "user.email=worker@openclaw.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "Worker base",
    ]);
    const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(workspaceDir, ".git", "shallow"), `${baseCommit}\n`);

    await withEnvAsync(
      {
        GIT_CONFIG_GLOBAL: globalConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: proofDir,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "",
        no_proxy: "",
        GIT_SSL_CAINFO: certPath,
        OPENCLAW_FORGEJO_USERNAME: forgejoUsername,
        OPENCLAW_FORGEJO_PASSWORD: forgejoPassword,
        WORKER_PROOF_GITHUB_LOGIN: githubLogin,
        WORKER_PROOF_PROXY: proxyUrl,
        WORKER_PROOF_CA: certPath,
      },
      async () => {
        await runWorkerCli(launch);

        const workerMessages = gateway.inferenceRequests.flatMap(
          (request) => request.context.messages,
        );
        const toolResult = workerMessages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "exec",
        );
        expect(toolResult).toMatchObject({ isError: false });
        const content = toolResult?.content;
        const output =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
              : "";
        if (authenticatedHosts.size !== 2) {
          const safeOutput = output
            .replaceAll(binding.token, "[redacted]")
            .replaceAll(forgejoUsername, "[redacted]")
            .replaceAll(forgejoPassword, "[redacted]");
          throw new Error(
            `Managed worker did not authenticate both HTTPS hosts; authenticated=${JSON.stringify([...authenticatedHosts])}; output=${safeOutput.slice(0, 1800)}`,
          );
        }
        expect([...authenticatedHosts].toSorted()).toEqual(["forgejo.example", "github.com"]);
        expect(output).toContain(createHash("sha256").update(binding.token).digest("hex"));
        expect(output).toContain("github-token=");
        expect(output).toContain("helpers-start");
        expect(output).toContain("profile-active");
        expect(output).toContain("profile-identity=matched");
        expect(output).toContain([`refs/heads/${binding.branch}`, binding.remoteUrl].join("\n"));
        expect(
          output
            .split("\n")
            .filter((line) => line.startsWith("command\t"))
            .map((line) => line.slice("command\t".length)),
        ).toEqual(["", "!gh auth git-credential"]);
        const helpers = output.split("helpers-start\n")[1]?.split("\nhelpers-end")[0]?.split("\n");
        // The empty scoped value resets inherited helpers only for GitHub HTTPS.
        expect(helpers?.slice(helpers.lastIndexOf(""))).toEqual(["", "!gh auth git-credential"]);
        expect(output).toContain("forgejo-authenticated\ngithub-authenticated");
        expect(JSON.stringify(gateway.transcriptRequests)).not.toContain(binding.token);
        expect(JSON.stringify(gateway.liveEventRequests)).not.toContain(binding.token);
        expect([...proxyTargets.keys()].toSorted()).toEqual([...allowedProxyTargets].toSorted());
        expect(proxyTargets.get("github.com:443")).toBeGreaterThanOrEqual(2);
        expect(proxyTargets.get("forgejo.example:443")).toBeGreaterThanOrEqual(1);
        process.stdout.write(
          `worker CLI authenticated HTTPS: forgejo-authenticated, github-authenticated; loopback CONNECT: github.com=${proxyTargets.get("github.com:443")}, forgejo.example=${proxyTargets.get("forgejo.example:443")}; profile active and assigned identity matched\n`,
        );
      },
    );
  } finally {
    await Promise.all([
      closeServer(proxyServer),
      closeServer(tlsServer),
      rm(proofDir, { recursive: true, force: true }),
    ]);
  }
}
