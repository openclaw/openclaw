import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer, type Server } from "node:https";
import path from "node:path";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import { GatewayClientRequestTimeoutError } from "../../../packages/gateway-client/src/client.ts";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/gateway-error-codes.ts";
import type { OpenClawConfig } from "../../../src/config/types.ts";
import { validateConfigObjectRaw } from "../../../src/config/validation-core.ts";
import type { GatewayClientOptions } from "../../../src/gateway/client.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import type { OpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import type { createLoopbackTlsFixture } from "../../../test/helpers/loopback-tls.test-support.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const proofSkill =
  "---\nname: transport-proof\ndescription: A synthetic reusable procedure\n---\n# Transport proof\nRead references/checklist.md before running scripts/task.sh.\n";
export const proofText = "Synthetic companion: preserve every byte.\n";
export const proofBinary = Buffer.from([0, 255, 128, 42, 10]);
export const proofExecutable = "#!/bin/sh\nprintf synthetic\n";
export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function createProofArchive() {
  const { default: JSZip } = await import("jszip");
  return new JSZip()
    .file("repository-main/skills/proof/SKILL.md", proofSkill)
    .file("repository-main/skills/proof/references/checklist.md", proofText)
    .file("repository-main/skills/proof/assets/sample.bin", proofBinary)
    .file("repository-main/skills/proof/scripts/task.sh", proofExecutable, {
      unixPermissions: 0o100755,
    })
    .generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

type Reply = { body?: Buffer; location?: string };
export async function createProofSource(
  tls: ReturnType<typeof createLoopbackTlsFixture>,
  archive: Buffer,
) {
  const counts = new Map<string, number>();
  const routes = new Map<string, Reply>();
  const holds = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let connections = 0;
  const handler: RequestListener = (request, response) => {
    const pathname = new URL(request.url ?? "/", "https://localhost").pathname;
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    void (async () => {
      const hold = holds.get(pathname);
      if (hold) {
        await hold.promise;
      }
      if (response.destroyed) {
        return;
      }
      const reply = routes.get(pathname) ?? { body: archive };
      response.setHeader("connection", "close");
      if (reply.location) {
        response.writeHead(302, { location: reply.location });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/zip" });
        response.end(reply.body);
      }
    })().catch(() => response.destroy());
  };
  const server = createServer({ key: tls.key, cert: tls.cert }, handler);
  const alternate = createServer({ key: tls.key, cert: tls.cert }, handler);
  for (const listener of [server, alternate]) {
    listener.on("connection", () => {
      connections += 1;
    });
  }
  const port = await listen(server);
  try {
    await listen(alternate, port, "127.0.0.2");
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    origin: "https://127.0.0.1:" + port,
    alternateOrigin: "https://127.0.0.2:" + port,
    connections: () => connections,
    count: (pathname: string) => counts.get(pathname) ?? 0,
    redirect(pathname: string, location: string) {
      routes.set(pathname, { location });
    },
    hold(pathname: string, location?: string) {
      const released = Promise.withResolvers<void>();
      holds.set(pathname, released);
      routes.set(pathname, location ? { location } : { body: archive });
      return { release: () => released.resolve() };
    },
    releaseAll() {
      for (const hold of holds.values()) {
        hold.resolve();
      }
    },
    async close() {
      for (const hold of holds.values()) {
        hold.resolve();
      }
      await runQaGatewayFixture(
        async () => {},
        () => closeServer(server),
        () => closeServer(alternate),
      );
    },
  };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function listen(server: Server, port = 0, host = "127.0.0.1") {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Missing owned source port"));
      } else {
        resolve(address.port);
      }
    });
  });
}

/** The real production install-policy owner launches this process; it never sees test callbacks. */
export async function createProofPolicy(root: string) {
  const script = path.join(root, "install-policy.cjs");
  const entered = path.join(root, "policy-entered");
  const release = path.join(root, "policy-release");
  const receipt = path.join(root, "policy-receipts.jsonl");
  const lines = [
    "#!" + process.execPath,
    "const fs = require('node:fs');",
    "let input = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', async () => {",
    " const request = JSON.parse(input);",
    " const remote = request.source?.authority === 'third-party' && request.source.network === true;",
    " const name = request.targetName;",
    " if (name === 'publication-revoked') {",
    "  fs.writeFileSync(" + JSON.stringify(entered) + ", 'entered');",
    "  const deadline = Date.now() + 27000;",
    "  while (!fs.existsSync(" + JSON.stringify(release) + ")) {",
    "   if (Date.now() >= deadline) process.exit(2);",
    "   await new Promise(resolve => setTimeout(resolve, 25));",
    "  }",
    " }",
    " const decision = name === 'policy-denied' ? 'block' : 'allow';",
    " fs.appendFileSync(" +
      JSON.stringify(receipt) +
      ", JSON.stringify({ remote, name, decision }) + String.fromCharCode(10));",
    " process.stdout.write(JSON.stringify({ protocolVersion: 1, decision, reason: 'synthetic owned policy' }));",
    "});",
  ];
  await fs.writeFile(script, lines.join("\n"), { mode: 0o700 });
  return {
    config: {
      enabled: true,
      exec: { source: "exec" as const, command: script, trustedDirs: [root], timeoutMs: 30000 },
    },
    async entered() {
      return fs.access(entered).then(
        () => true,
        () => false,
      );
    },
    async release() {
      await fs.writeFile(release, "release");
    },
    async receipts() {
      const text = await fs.readFile(receipt, "utf8").catch(() => "");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
    },
  };
}

export type ImportProofReport = {
  schemaVersion: 1;
  status: "running" | "partial" | "passed" | "failed";
  authorityStatus: "running" | "passed" | "failed";
  upgradeStatus: "not-run" | "running" | "passed" | "failed";
  upgradeFailedStage?: string;
  failedStage?: string;
  failureDiagnostics?: ReturnType<typeof classifySkillProofFailure>;
  source: { expectedHead: string; observedHead: string; tree: string; buildCommit: string };
  assertions: Array<{
    id: string;
    passed: boolean;
    receivedRequests?: number;
    nextRequests?: number;
    configVersions?: { before: string; after: string };
    connectionStable?: boolean;
  }>;
  cleanup?: {
    scope: "candidate-authority";
    gatewaysAndClientsStopped: boolean;
    sourcesClosed: boolean;
    testStateReleased: boolean;
    testCaTrustRestored: boolean;
  };
  screenshots?: {
    kind: "actual-dialog-crop";
    viewport: { width: number; height: number };
    theme: "light";
    files: string[];
  };
  profileOwnership?: { expected: string; observed: string };
  files?: Array<{ path: string; sha256: string; executable: boolean; sizeBytes: number }>;
  upgrade?: {
    version: string;
    integrity: string;
    packageSha256: string;
    signatureVerified: boolean;
    preserved: boolean;
    originalUnchanged: boolean;
    revisions: string[];
    revisionHashesBefore: string[];
    revisionHashesAfter: string[];
    originalStateHashBefore: string;
    originalStateHashAfter: string;
    settingsPreserved: boolean;
    settingsHashBefore: string;
    settingsHashAfter: string;
    legacySkillPreserved: boolean;
    doctorSucceeded: boolean;
    newImportSucceeded: boolean;
  };
};

// A trusted-proxy operator fixture must use the public browser lane its configured pairing policy admits.
export function skillProofOperatorClientOptions(
  state: OpenClawTestState,
  actor: string,
  url: string,
  origin: string,
  scopes: string[],
): GatewayClientOptions {
  return {
    url,
    origin,
    clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    role: "operator",
    scopes,
    sharedStateMode: "read-only",
    deviceIdentity: loadOrCreateDeviceIdentity({
      env: state.env,
      identityKey: "skills-proof-" + actor,
    }),
  };
}

export function classifySkillProofFailure(error: unknown) {
  const errors = collectErrorGraphCandidates(error, readErrorCauses).slice(0, 8);
  const messages = errors.map((item) =>
    formatErrorMessage(item).slice(0, 4096).replace(/\s+/gu, " "),
  );
  const names = new Set(errors.map(readErrorName));
  const allowedCodes = [
    ...Object.values(ErrorCodes),
    "INVALID_CONFIG",
    "ERR_ASSERTION",
    "CLIENT_TIMEOUT",
    "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_WORKER_INIT_FAILED",
    "ERR_WORKER_NOT_RUNNING",
    "ERR_WORKER_OUT_OF_MEMORY",
    "ERR_DLOPEN_FAILED",
    "ENOENT",
    "EACCES",
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
    "SQLITE_CANTOPEN",
    "ERR_SQLITE_ERROR",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "ABORT_ERR",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ];
  const codes = allowedCodes.filter(
    (code) =>
      errors.some((item) => extractErrorCode(item) === code) ||
      messages.some((message) => message.includes(code)),
  );
  const kinds: string[] = [];
  if (names.has("AssertionError")) {
    kinds.push("assertion");
  }
  if (
    messages.some((message) => message.includes("Owned profile authentication did not complete"))
  ) {
    kinds.push("gateway-hello-timeout");
  }
  if (messages.some((message) => /gateway.*closed|closed.*before hello/iu.test(message))) {
    kinds.push("gateway-close");
  }
  if (
    messages.some((message) =>
      /worker.*(?:timed out|timeout)|(?:timed out|timeout).*worker/iu.test(message),
    )
  ) {
    kinds.push("worker-timeout");
  }
  if (messages.some((message) => /timed out|timeout|deadline/iu.test(message))) {
    kinds.push("timeout");
  }
  if (
    names.has("ZodError") ||
    codes.includes("INVALID_CONFIG") ||
    messages.some((message) => message.includes("Invalid owned proof config"))
  ) {
    kinds.push("config-validation");
  }
  if (codes.some((code) => /CERT|TLS|SELF_SIGNED/iu.test(code))) {
    kinds.push("tls");
  }
  if (codes.some((code) => ["NOT_LINKED", "NOT_PAIRED"].includes(code))) {
    kinds.push("authentication");
  }
  if (
    messages.some((message) =>
      /missing scope|unauthorized|authentication required|pairing required/iu.test(message),
    )
  ) {
    kinds.push("authentication");
  }
  if (codes.some((code) => Object.values(ErrorCodes).some((publicCode) => publicCode === code))) {
    kinds.push("gateway-rpc");
  }
  if (kinds.length === 0) {
    kinds.push("unclassified");
  }
  const reportedExitCodes = [
    ...new Set(
      messages
        .flatMap((message) =>
          [...message.matchAll(/(?:exited with|exit) code ([0-9]{1,3})/giu)].map((match) =>
            Number(match[1]),
          ),
        )
        .filter((code) => code <= 255),
    ),
  ].slice(0, 4);
  const clientTimeouts = errors.flatMap((item) =>
    item instanceof GatewayClientRequestTimeoutError &&
    ["skills.library.list", "skills.library.import", "config.get", "config.patch"].includes(
      item.method,
    )
      ? [{ method: item.method, timeoutMs: item.timeoutMs, requestSent: item.requestSent }]
      : [],
  );
  // Only fixed categories/codes and scalar counts leave the private error graph.
  return {
    kinds: [...new Set(kinds)],
    codes,
    names: [
      "Error",
      "TypeError",
      "ReferenceError",
      "RangeError",
      "AggregateError",
      "AssertionError",
      "TimeoutError",
      "AbortError",
      "ZodError",
    ].filter((name) => names.has(name)),
    reportedExitCodes,
    clientTimeouts,
    errorNodes: errors.length,
  };
}

export async function writePublicProof(directory: string, report: ImportProofReport) {
  // Completion is derived here; candidate success alone must never publish a whole-proof pass.
  report.status =
    report.authorityStatus === "failed"
      ? "failed"
      : report.authorityStatus === "passed" && report.upgradeStatus === "passed"
        ? "passed"
        : report.authorityStatus === "passed"
          ? "partial"
          : report.upgradeStatus === "failed"
            ? "failed"
            : "running";
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

export function createSkillImportProofConfig(options: {
  workspaceDir: string;
  uiOrigin: string;
  emails: string[];
  scopes: string[];
  origins: string[];
  installPolicy: NonNullable<OpenClawConfig["security"]>["installPolicy"];
}) {
  const config = {
    agents: {
      defaults: { workspace: options.workspaceDir, model: { primary: "fixture/no-model" } },
      entries: { main: {} },
    },
    gateway: {
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { allowedOrigins: [options.uiOrigin] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          allowLoopback: true,
          allowUsers: options.emails,
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          deviceAutoApprove: { enabled: true, scopes: options.scopes },
        },
      },
      roles: {
        default: "reader",
        definitions: {
          writer: { agents: ["main"], sessions: { others: "view" }, scopes: options.scopes },
          reader: { agents: ["main"], sessions: { others: "view" }, scopes: ["operator.read"] },
        },
      },
    },
    skills: { library: { import: { allowedOrigins: options.origins } } },
    security: { installPolicy: options.installPolicy },
  };
  const validation = validateConfigObjectRaw(config);
  if (!validation.ok) {
    throw new Error(
      "Invalid owned proof config: " + validation.issues.map((issue) => issue.path).join(", "),
    );
  }
  return validation.config;
}
