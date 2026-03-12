/**
 * HashiCorp Vault secret provider (KV v2 engine).
 *
 * Uses native `fetch()` — no SDK dependency. Supports:
 * - Token, AppRole, Kubernetes auth methods
 * - KV v2 read/write/list with version pinning
 * - Lease management for dynamic secrets
 * - Rotation tracking via custom_metadata on KV v2
 */

import { readFile } from "node:fs/promises";
import type { SecretProvider } from "./secret-resolution.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultConfig {
  address: string;
  namespace?: string;
  mountPath?: string; // default: "secret"
  authMethod?: "token" | "approle" | "kubernetes";
  token?: string;
  tokenFile?: string;
  roleId?: string;
  secretId?: string;
  cacheTtlSeconds?: number;
}

export interface VaultLease {
  leaseId: string;
  data: Record<string, string>;
  ttl: number;
  renewable: boolean;
  expiresAt: Date;
}

interface VaultResponse {
  data?: {
    data?: Record<string, unknown>;
    metadata?: {
      version?: number;
      custom_metadata?: Record<string, string> | null;
    };
    keys?: string[];
  };
  auth?: {
    client_token?: string;
    lease_duration?: number;
    renewable?: boolean;
  };
  lease_id?: string;
  lease_duration?: number;
  renewable?: boolean;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly vaultErrors?: string[],
  ) {
    super(message);
    this.name = "VaultError";
  }
}

function mapVaultHttpError(
  statusCode: number,
  path: string,
  body?: { errors?: string[] },
): VaultError {
  const errors = body?.errors;
  switch (statusCode) {
    case 403:
      return new VaultError(
        `Permission denied. Check Vault policy for path '${path}'.`,
        403,
        errors,
      );
    case 404:
      return new VaultError(`Secret not found at path '${path}'.`, 404, errors);
    case 503:
      return new VaultError("Vault is sealed. Unseal before use.", 503, errors);
    default:
      return new VaultError(
        `Vault request failed (HTTP ${statusCode}) for path '${path}'${errors?.length ? `: ${errors.join(", ")}` : ""}`,
        statusCode,
        errors,
      );
  }
}

// ---------------------------------------------------------------------------
// VaultSecretProvider
// ---------------------------------------------------------------------------

export class VaultSecretProvider implements SecretProvider {
  public readonly name = "vault";
  private readonly address: string;
  private readonly namespace?: string;
  private readonly mountPath: string;
  private readonly authMethod: "token" | "approle" | "kubernetes";
  private readonly configToken?: string;
  private readonly tokenFile?: string;
  private readonly roleId?: string;
  private readonly secretId?: string;
  public readonly cacheTtlMs: number;

  private cachedToken?: string;

  // Allow injection for testing
  public _fetchFn: typeof globalThis.fetch = globalThis.fetch;

  constructor(config: VaultConfig) {
    this.address = config.address.replace(/\/+$/, "");
    this.namespace = config.namespace;
    this.mountPath = config.mountPath ?? "secret";
    this.authMethod = config.authMethod ?? "token";
    this.configToken = config.token;
    this.tokenFile = config.tokenFile;
    this.roleId = config.roleId;
    this.secretId = config.secretId;
    this.cacheTtlMs = (config.cacheTtlSeconds ?? 300) * 1000;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private async getToken(): Promise<string> {
    if (this.cachedToken) {
      return this.cachedToken;
    }

    let token: string | undefined;

    switch (this.authMethod) {
      case "token":
        token = this.configToken ?? process.env.VAULT_TOKEN;
        if (!token && this.tokenFile) {
          token = (await readFile(this.tokenFile, "utf-8")).trim();
        }
        if (!token) {
          throw new VaultError(
            "No Vault token. Set VAULT_TOKEN, use token config, or configure AppRole.",
          );
        }
        break;

      case "approle":
        if (!this.roleId || !this.secretId) {
          throw new VaultError("AppRole auth requires roleId and secretId.");
        }
        token = await this.loginAppRole(this.roleId, this.secretId);
        break;

      case "kubernetes":
        token = await this.loginKubernetes();
        break;
    }

    this.cachedToken = token;
    return token;
  }

  private async loginAppRole(roleId: string, secretId: string): Promise<string> {
    const resp = await this.rawRequest("POST", "/v1/auth/approle/login", {
      role_id: roleId,
      secret_id: secretId,
    });
    const token = resp.auth?.client_token;
    if (!token) {
      throw new VaultError("AppRole login did not return a token.");
    }
    return token;
  }

  private async loginKubernetes(): Promise<string> {
    let jwt: string;
    try {
      jwt = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf-8")).trim();
    } catch {
      throw new VaultError(
        "Kubernetes auth: cannot read service account token at /var/run/secrets/kubernetes.io/serviceaccount/token",
      );
    }
    const resp = await this.rawRequest("POST", "/v1/auth/kubernetes/login", {
      role: "openclaw",
      jwt,
    });
    const token = resp.auth?.client_token;
    if (!token) {
      throw new VaultError("Kubernetes login did not return a token.");
    }
    return token;
  }

  /** Clear cached token to force re-auth. */
  public clearTokenCache(): void {
    this.cachedToken = undefined;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    skipAuth = false,
  ): Promise<VaultResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (!skipAuth) {
      // For login endpoints, we don't need a token yet
      if (!path.startsWith("/v1/auth/")) {
        const token = await this.getToken();
        headers["X-Vault-Token"] = token;
      }
    }

    if (this.namespace) {
      headers["X-Vault-Namespace"] = this.namespace;
    }

    const url = `${this.address}${path}`;
    let resp: Response;
    try {
      resp = await this._fetchFn(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new VaultError(
        `Cannot connect to Vault at '${this.address}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!resp.ok) {
      let parsed: { errors?: string[] } | undefined;
      try {
        parsed = (await resp.json()) as { errors?: string[] };
      } catch {
        /* ignore parse errors */
      }
      throw mapVaultHttpError(resp.status, path, parsed);
    }

    // Some endpoints return 204 with no body
    if (resp.status === 204) {
      return {};
    }

    return (await resp.json()) as VaultResponse;
  }

  private async request(method: string, path: string, body?: unknown): Promise<VaultResponse> {
    try {
      return await this.rawRequest(method, path, body);
    } catch (err) {
      // On 403, try re-auth for renewable auth methods, then retry once
      if (err instanceof VaultError && err.statusCode === 403 && this.authMethod !== "token") {
        this.clearTokenCache();
        return await this.rawRequest(method, path, body);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // SecretProvider interface
  // -------------------------------------------------------------------------

  async getSecret(secretName: string, version?: string): Promise<string> {
    const versionQuery = version ? `?version=${version}` : "";
    const path = `/v1/${this.mountPath}/data/${secretName}${versionQuery}`;
    const resp = await this.request("GET", path);
    const data = resp.data?.data;
    if (!data) {
      throw new VaultError(`Secret '${secretName}' has no data.`, 404);
    }
    // Extract the 'value' field, or return the whole JSON if no 'value' key
    if ("value" in data) {
      return String(data.value);
    }
    return JSON.stringify(data);
  }

  async setSecret(secretName: string, value: string): Promise<void> {
    const path = `/v1/${this.mountPath}/data/${secretName}`;
    await this.request("POST", path, { data: { value } });
  }

  async listSecrets(): Promise<string[]> {
    const path = `/v1/${this.mountPath}/metadata/`;
    // Vault LIST is done via the LIST HTTP method or GET with ?list=true
    try {
      const resp = await this.request("LIST", path);
      return (resp.data?.keys as string[]) ?? [];
    } catch (err) {
      if (err instanceof VaultError && err.statusCode === 404) {
        return [];
      }
      throw err;
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await this._fetchFn(`${this.address}/v1/sys/health`, {
        headers: this.namespace ? { "X-Vault-Namespace": this.namespace } : {},
      });
      if (resp.ok) {
        return { ok: true };
      }
      if (resp.status === 503) {
        return { ok: false, error: "Vault is sealed." };
      }
      return { ok: false, error: `Vault health check returned HTTP ${resp.status}` };
    } catch (err) {
      return {
        ok: false,
        error: `Cannot connect to Vault at '${this.address}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic Secrets / Lease Management
  // -------------------------------------------------------------------------

  async requestDynamic(backend: string, role: string): Promise<VaultLease> {
    const path = `/v1/${backend}/creds/${role}`;
    const resp = await this.request("GET", path);
    const data = resp.data?.data ?? (resp as unknown as { data?: Record<string, unknown> }).data;
    const leaseData: Record<string, string> = {};
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        leaseData[k] = String(v);
      }
    }
    const ttl = resp.lease_duration ?? 0;
    return {
      leaseId: resp.lease_id ?? "",
      data: leaseData,
      ttl,
      renewable: resp.renewable ?? false,
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }

  async renewLease(leaseId: string, increment?: number): Promise<VaultLease> {
    const body: Record<string, unknown> = { lease_id: leaseId };
    if (increment !== undefined) {
      body.increment = increment;
    }
    const resp = await this.request("PUT", "/v1/sys/leases/renew", body);
    const ttl = resp.lease_duration ?? 0;
    return {
      leaseId: resp.lease_id ?? leaseId,
      data: {},
      ttl,
      renewable: resp.renewable ?? false,
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }

  async revokeLease(leaseId: string): Promise<void> {
    await this.request("PUT", "/v1/sys/leases/revoke", { lease_id: leaseId });
  }

  // -------------------------------------------------------------------------
  // Static Rotation Polling
  // -------------------------------------------------------------------------

  async getStaticCreds(
    mount: string,
    role: string,
  ): Promise<{ username: string; password: string; lastVaultRotation: string; ttl: number }> {
    const path = `/v1/${mount}/static-creds/${role}`;
    const resp = await this.request("GET", path);
    const data = resp.data?.data as Record<string, string | number> | undefined;
    return {
      username: typeof data?.username === "string" ? data.username : "",
      password: typeof data?.password === "string" ? data.password : "",
      lastVaultRotation:
        typeof data?.last_vault_rotation === "string" ? data.last_vault_rotation : "",
      ttl: typeof data?.ttl === "number" ? data.ttl : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Rotation Metadata (KV v2 custom_metadata)
  // -------------------------------------------------------------------------

  async getSecretMetadata(
    secretName: string,
  ): Promise<{ customMetadata: Record<string, string>; currentVersion: number }> {
    const path = `/v1/${this.mountPath}/metadata/${secretName}`;
    const resp = await this.request("GET", path);
    const meta = resp.data as unknown as {
      custom_metadata?: Record<string, string> | null;
      current_version?: number;
    };
    return {
      customMetadata: meta?.custom_metadata ?? {},
      currentVersion: meta?.current_version ?? 0,
    };
  }

  async updateSecretMetadata(
    secretName: string,
    customMetadata: Record<string, string>,
  ): Promise<void> {
    const path = `/v1/${this.mountPath}/metadata/${secretName}`;
    await this.request("POST", path, { custom_metadata: customMetadata });
  }
}

// ---------------------------------------------------------------------------
// VaultLeaseManager — tracks active leases, handles renewal scheduling
// ---------------------------------------------------------------------------

export class VaultLeaseManager {
  private activeLeases = new Map<string, VaultLease>();
  private renewalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly renewalBuffer: number; // fraction of TTL remaining to trigger renewal

  constructor(
    private readonly provider: VaultSecretProvider,
    opts?: { renewalBuffer?: number },
  ) {
    this.renewalBuffer = opts?.renewalBuffer ?? 0.33;
  }

  async requestDynamic(backend: string, role: string): Promise<VaultLease> {
    const lease = await this.provider.requestDynamic(backend, role);
    this.trackLease(lease);
    return lease;
  }

  private trackLease(lease: VaultLease): void {
    this.activeLeases.set(lease.leaseId, lease);
    if (lease.renewable && lease.ttl > 0) {
      this.scheduleRenewal(lease);
    }
  }

  private scheduleRenewal(lease: VaultLease): void {
    // Clear existing timer
    const existing = this.renewalTimers.get(lease.leaseId);
    if (existing) {
      clearTimeout(existing);
    }

    const renewAt = lease.ttl * (1 - this.renewalBuffer) * 1000;
    const timer = setTimeout(async () => {
      try {
        const renewed = await this.provider.renewLease(lease.leaseId);
        renewed.data = lease.data; // preserve original creds
        this.activeLeases.set(lease.leaseId, renewed);
        if (renewed.renewable && renewed.ttl > 0) {
          this.scheduleRenewal(renewed);
        }
      } catch {
        // Renewal failed — remove lease
        this.activeLeases.delete(lease.leaseId);
        this.renewalTimers.delete(lease.leaseId);
      }
    }, renewAt);

    // Unref so it doesn't keep the process alive
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    this.renewalTimers.set(lease.leaseId, timer);
  }

  listActiveLeases(): VaultLease[] {
    return Array.from(this.activeLeases.values());
  }

  async revokeAll(): Promise<void> {
    for (const [id] of this.renewalTimers) {
      clearTimeout(this.renewalTimers.get(id));
    }
    this.renewalTimers.clear();

    const revocations = Array.from(this.activeLeases.keys()).map(async (id) => {
      try {
        await this.provider.revokeLease(id);
      } catch {
        // best-effort
      }
    });
    await Promise.allSettled(revocations);
    this.activeLeases.clear();
  }
}
