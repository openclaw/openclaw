import { createPrivateKey, createSign } from "node:crypto";
import { resolveGitHubApiBaseUrl } from "../../agents/github-host.js";

type AppConfig = {
  appId: number;
  installationId: number;
  privateKey: ReturnType<typeof createPrivateKey>;
};

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolveAppConfig(env: NodeJS.ProcessEnv): AppConfig | undefined {
  const names = [
    "OPENCLAW_GITHUB_APP_ID",
    "OPENCLAW_GITHUB_INSTALLATION_ID",
    "OPENCLAW_GITHUB_APP_PRIVATE_KEY",
  ] as const;
  const configured = names.filter((name) => Boolean(env[name]));
  if (configured.length === 0) return undefined;
  if (configured.length !== names.length)
    throw new Error("Worker GitHub App issuer configuration is incomplete");
  const appId = positiveInteger(env.OPENCLAW_GITHUB_APP_ID);
  const installationId = positiveInteger(env.OPENCLAW_GITHUB_INSTALLATION_ID);
  if (!appId || !installationId || !env.OPENCLAW_GITHUB_APP_PRIVATE_KEY) {
    throw new Error("Worker GitHub App issuer configuration is invalid");
  }
  return {
    appId,
    installationId,
    privateKey: createPrivateKey(env.OPENCLAW_GITHUB_APP_PRIVATE_KEY),
  };
}

function appJwt(config: AppConfig, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: String(config.appId),
    iat: seconds - 60,
    exp: seconds + 540,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
}

export type WorkerGitHubInstallationTokenGrant = {
  token: string;
  expiresAtMs: number;
  revoke: () => Promise<void>;
};

export async function issueWorkerGitHubInstallationToken(params: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<WorkerGitHubInstallationTokenGrant | undefined> {
  const config = resolveAppConfig(params.env ?? process.env);
  if (!config) return undefined;
  const apiBase = resolveGitHubApiBaseUrl(params.env);
  const transport = params.fetch ?? fetch;
  const response = await transport(
    `${apiBase}/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      redirect: "error",
      signal: params.signal ?? AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${appJwt(config)}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: "{}",
    },
  );
  if (!response.ok) throw new Error("GitHub installation-token issuance failed");
  const issued: unknown = await response.json();
  const record = issued && typeof issued === "object" ? (issued as Record<string, unknown>) : {};
  const token = typeof record.token === "string" ? record.token : "";
  const expiresAtMs = typeof record.expires_at === "string" ? Date.parse(record.expires_at) : 0;
  const revokeToken = async () =>
    await transport(`${apiBase}/installation/token`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  const invalid = !token || !(expiresAtMs > Date.now());
  if (invalid) {
    if (token) await revokeToken().catch(() => undefined);
    throw new Error("GitHub returned an invalid installation token");
  }
  let active = true;
  return {
    token,
    expiresAtMs,
    revoke: async () => {
      if (!active) return;
      active = false;
      const revoked = await revokeToken();
      if (!revoked.ok && revoked.status !== 404) {
        active = true;
        throw new Error("GitHub installation-token revocation failed");
      }
    },
  };
}
