import fs from "node:fs";
import path from "node:path";

import { hasBinary } from "../agents/skills.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { normalizeServePath } from "./gmail.js";

export async function ensureDependency(bin: string, brewArgs: string[]) {
  if (hasBinary(bin)) return;
  if (process.platform !== "darwin") {
    throw new Error(`${bin} not installed; install it and retry`);
  }
  if (!hasBinary("brew")) {
    throw new Error("Homebrew not installed (install brew and retry)");
  }
  const result = await runCommandWithTimeout(["brew", "install", ...brewArgs], {
    timeoutMs: 600_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `brew install failed for ${bin}: ${result.stderr || result.stdout}`,
    );
  }
  if (!hasBinary(bin)) {
    throw new Error(`${bin} still not available after brew install`);
  }
}

export async function ensureGcloudAuth() {
  const res = await runCommandWithTimeout(
    [
      "gcloud",
      "auth",
      "list",
      "--filter",
      "status:ACTIVE",
      "--format",
      "value(account)",
    ],
    { timeoutMs: 30_000 },
  );
  if (res.code === 0 && res.stdout.trim()) return;
  const login = await runCommandWithTimeout(["gcloud", "auth", "login"], {
    timeoutMs: 600_000,
  });
  if (login.code !== 0) {
    throw new Error(login.stderr || "gcloud auth login failed");
  }
}

export async function runGcloud(args: string[]) {
  const result = await runCommandWithTimeout(["gcloud", ...args], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "gcloud command failed");
  }
  return result;
}

export async function ensureTopic(projectId: string, topicName: string) {
  const describe = await runCommandWithTimeout(
    [
      "gcloud",
      "pubsub",
      "topics",
      "describe",
      topicName,
      "--project",
      projectId,
    ],
    { timeoutMs: 30_000 },
  );
  if (describe.code === 0) return;
  await runGcloud([
    "pubsub",
    "topics",
    "create",
    topicName,
    "--project",
    projectId,
  ]);
}

export async function ensureSubscription(
  projectId: string,
  subscription: string,
  topicName: string,
  pushEndpoint: string,
) {
  const describe = await runCommandWithTimeout(
    [
      "gcloud",
      "pubsub",
      "subscriptions",
      "describe",
      subscription,
      "--project",
      projectId,
    ],
    { timeoutMs: 30_000 },
  );
  if (describe.code === 0) {
    await runGcloud([
      "pubsub",
      "subscriptions",
      "update",
      subscription,
      "--project",
      projectId,
      "--push-endpoint",
      pushEndpoint,
    ]);
    return;
  }
  await runGcloud([
    "pubsub",
    "subscriptions",
    "create",
    subscription,
    "--project",
    projectId,
    "--topic",
    topicName,
    "--push-endpoint",
    pushEndpoint,
  ]);
}

export async function ensureTailscaleEndpoint(params: {
  mode: "off" | "serve" | "funnel";
  path: string;
  port: number;
  token?: string;
}): Promise<string> {
  if (params.mode === "off") return "";

  const status = await runCommandWithTimeout(
    ["tailscale", "status", "--json"],
    {
      timeoutMs: 30_000,
    },
  );
  if (status.code !== 0) {
    throw new Error(status.stderr || "tailscale status failed");
  }
  const parsed = JSON.parse(status.stdout) as {
    Self?: { DNSName?: string };
  };
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) {
    throw new Error("tailscale DNS name missing; run tailscale up");
  }

  const target = String(params.port);
  const pathArg = normalizeServePath(params.path);
  const funnelArgs = [
    "tailscale",
    params.mode,
    "--bg",
    "--set-path",
    pathArg,
    "--yes",
    target,
  ];
  const funnelResult = await runCommandWithTimeout(funnelArgs, {
    timeoutMs: 30_000,
  });
  if (funnelResult.code !== 0) {
    throw new Error(funnelResult.stderr || "tailscale funnel failed");
  }

  const baseUrl = `https://${dnsName}${pathArg}`;
  // Funnel/serve strips pathArg before proxying; keep it only in the public URL.
  return params.token ? `${baseUrl}?token=${params.token}` : baseUrl;
}

export async function resolveProjectIdFromGogCredentials(): Promise<
  string | null
> {
  const candidates = gogCredentialsPaths();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const clientId = extractGogClientId(parsed);
      const projectNumber = extractProjectNumber(clientId);
      if (!projectNumber) continue;
      const res = await runCommandWithTimeout(
        [
          "gcloud",
          "projects",
          "list",
          "--filter",
          `projectNumber=${projectNumber}`,
          "--format",
          "value(projectId)",
        ],
        { timeoutMs: 30_000 },
      );
      if (res.code !== 0) continue;
      const projectId = res.stdout.trim().split(/\s+/)[0];
      if (projectId) return projectId;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function gogCredentialsPaths(): string[] {
  const paths: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    paths.push(path.join(xdg, "gogcli", "credentials.json"));
  }
  paths.push(resolveUserPath("~/.config/gogcli/credentials.json"));
  if (process.platform === "darwin") {
    paths.push(
      resolveUserPath("~/Library/Application Support/gogcli/credentials.json"),
    );
  }
  return paths;
}

function extractGogClientId(parsed: Record<string, unknown>): string | null {
  const installed = parsed.installed as Record<string, unknown> | undefined;
  const web = parsed.web as Record<string, unknown> | undefined;
  const candidate =
    installed?.client_id || web?.client_id || parsed.client_id || "";
  return typeof candidate === "string" ? candidate : null;
}

function extractProjectNumber(clientId: string | null): string | null {
  if (!clientId) return null;
  const match = clientId.match(/^(\d+)-/);
  return match?.[1] ?? null;
}
