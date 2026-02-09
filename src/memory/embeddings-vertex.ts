import crypto from "node:crypto";
import fs from "node:fs";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type VertexEmbeddingClient = {
  project: string;
  location: string;
  model: string;
  getAccessToken: () => Promise<string>;
};

export const DEFAULT_VERTEX_EMBEDDING_MODEL = "text-embedding-005";

const DEFAULT_VERTEX_LOCATION = "us-central1";
const SCOPES = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Cached token state (module-scoped).
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

function resolveLocation(): string {
  const raw = process.env.GOOGLE_CLOUD_LOCATION?.trim();
  if (!raw || raw === "global") {
    return DEFAULT_VERTEX_LOCATION;
  }
  return raw;
}

export function normalizeVertexModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_VERTEX_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("google-vertex/")) {
    return trimmed.slice("google-vertex/".length);
  }
  if (trimmed.startsWith("vertex/")) {
    return trimmed.slice("vertex/".length);
  }
  return trimmed;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

async function getAccessTokenFromServiceAccount(saPath: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  const sa: ServiceAccountKey = JSON.parse(fs.readFileSync(saPath, "utf-8"));
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");

  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vertex AI token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  // Cache with 5-minute safety margin.
  cachedToken = data.access_token;
  cachedTokenExpiry = now + data.expires_in - 300;
  return data.access_token;
}

async function getAccessTokenFromGcloud(): Promise<string> {
  const { execSync } = await import("node:child_process");
  const token = execSync("gcloud auth print-access-token", { encoding: "utf-8" }).trim();
  if (!token) {
    throw new Error("gcloud auth print-access-token returned empty result");
  }
  return token;
}

export async function resolveAccessToken(): Promise<string> {
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (saPath) {
    return getAccessTokenFromServiceAccount(saPath);
  }
  return getAccessTokenFromGcloud();
}

function buildPredictUrl(project: string, location: string, model: string): string {
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;
}

export async function createVertexEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: VertexEmbeddingClient }> {
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!project) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT environment variable is required for google-vertex embedding provider.",
    );
  }

  const location = resolveLocation();
  const model = normalizeVertexModel(options.model);
  const predictUrl = buildPredictUrl(project, location, model);

  const client: VertexEmbeddingClient = {
    project,
    location,
    model,
    getAccessToken: resolveAccessToken,
  };

  const predict = async (
    instances: Array<{ content: string; task_type: string }>,
  ): Promise<number[][]> => {
    if (instances.length === 0) {
      return [];
    }
    const token = await client.getAccessToken();
    const res = await fetch(predictUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instances }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`vertex embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };
    const predictions = payload.predictions ?? [];
    return predictions.map((p) => p.embeddings?.values ?? []);
  };

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const results = await predict([{ content: text, task_type: "RETRIEVAL_QUERY" }]);
    return results[0] ?? [];
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const instances = texts.map((text) => ({ content: text, task_type: "RETRIEVAL_DOCUMENT" }));
    return predict(instances);
  };

  return {
    provider: {
      id: "google-vertex",
      model,
      embedQuery,
      embedBatch,
    },
    client,
  };
}
