import { createSign } from "node:crypto";
import fsSync from "node:fs";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  normalizeGeminiModel,
  resolveGeminiOutputDimensionality,
} from "./embeddings-gemini.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderOptions,
  GeminiTaskType,
} from "./embeddings.types.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";

const GOOGLE_VERTEX_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export type GoogleVertexEmbeddingClient = {
  baseUrl: string;
  endpoint: string;
  headers: Record<string, string>;
  model: string;
  outputDimensionality?: number;
};

type GoogleServiceAccountCredentials = {
  type?: string;
  client_email?: string;
  private_key?: string;
  project_id?: string;
  quota_project_id?: string;
};

function normalizeOptionalSecretInput(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function resolveGoogleApplicationCredentialsPath(env = process.env): string | undefined {
  return normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
}

function resolveGoogleVertexRegion(env = process.env): string {
  return (
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_LOCATION) ||
    normalizeOptionalSecretInput(env.CLOUD_ML_REGION) ||
    "us-central1"
  );
}

function readGoogleServiceAccountCredentials(env = process.env): GoogleServiceAccountCredentials {
  const credentialsPath = resolveGoogleApplicationCredentialsPath(env);
  if (!credentialsPath) {
    throw new Error(
      "google-vertex embeddings require GOOGLE_APPLICATION_CREDENTIALS pointing to a service account JSON file.",
    );
  }
  let parsed: GoogleServiceAccountCredentials;
  try {
    parsed = JSON.parse(
      fsSync.readFileSync(credentialsPath, "utf8"),
    ) as GoogleServiceAccountCredentials;
  } catch (err) {
    throw new Error(
      `Failed to read Google service account credentials at ${credentialsPath}: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
  if (parsed?.type !== "service_account") {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS must point to a service account JSON file, got type "${parsed?.type ?? "unknown"}".`,
    );
  }
  if (typeof parsed.client_email !== "string" || !parsed.client_email) {
    throw new Error("Service account JSON is missing client_email.");
  }
  if (typeof parsed.private_key !== "string" || !parsed.private_key) {
    throw new Error("Service account JSON is missing private_key.");
  }
  return parsed;
}

function resolveGoogleVertexProjectId(
  env = process.env,
  credentials?: GoogleServiceAccountCredentials,
): string | undefined {
  return (
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT_ID) ||
    normalizeOptionalSecretInput(credentials?.project_id) ||
    normalizeOptionalSecretInput(credentials?.quota_project_id)
  );
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createGoogleServiceAccountJwtAssertion(
  credentials: GoogleServiceAccountCredentials,
): string {
  const now = Math.floor(Date.now() / 1e3);
  const header = encodeBase64UrlJson({ alg: "RS256", typ: "JWT" });
  const claimSet = encodeBase64UrlJson({
    iss: credentials.client_email,
    sub: credentials.client_email,
    aud: GOOGLE_VERTEX_TOKEN_URL,
    scope: GOOGLE_VERTEX_SCOPE,
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${claimSet}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(credentials.private_key!).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function fetchGoogleServiceAccountAccessToken(
  credentials: GoogleServiceAccountCredentials,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: createGoogleServiceAccountJwtAssertion(credentials),
  });
  const response = await fetch(GOOGLE_VERTEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`google-vertex token exchange failed: ${response.status} ${text}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("google-vertex token exchange failed: missing access_token");
  }
  return payload.access_token;
}

export async function createGoogleVertexEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: GoogleVertexEmbeddingClient }> {
  const model = normalizeGeminiModel(options.model || DEFAULT_GEMINI_EMBEDDING_MODEL);
  const credentials = readGoogleServiceAccountCredentials();
  const projectId = resolveGoogleVertexProjectId(process.env, credentials);
  if (!projectId) {
    throw new Error(
      "google-vertex embeddings require GOOGLE_CLOUD_PROJECT or a project_id in the service account JSON.",
    );
  }
  const region = resolveGoogleVertexRegion();
  const accessToken = await fetchGoogleServiceAccountAccessToken(credentials);
  const baseUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models`;
  const endpoint = `${baseUrl}/${model}:predict`;
  const outputDimensionality = resolveGeminiOutputDimensionality(
    model,
    options.outputDimensionality,
  );
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);

  debugEmbeddingsLog("memory embeddings: google-vertex client", {
    baseUrl,
    model,
    endpoint,
    outputDimensionality,
  });

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const payload = {
      instances: [
        {
          content: text,
          task_type: (options.taskType ?? "RETRIEVAL_QUERY") satisfies GeminiTaskType,
          ...(outputDimensionality != null ? { output_dimensionality: outputDimensionality } : {}),
        },
      ],
    };
    const result = await withRemoteHttpResponse({
      url: endpoint,
      ssrfPolicy,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          const textBody = await res.text();
          throw new Error(`google-vertex embeddings failed: ${res.status} ${textBody}`);
        }
        return (await res.json()) as {
          predictions?: Array<{ embeddings?: { values?: number[] } }>;
        };
      },
    });
    return sanitizeAndNormalizeEmbedding(result.predictions?.[0]?.embeddings?.values ?? []);
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    return await Promise.all(texts.map((text) => embedQuery(text)));
  };

  return {
    provider: {
      id: "google-vertex",
      model,
      embedQuery,
      embedBatch,
    },
    client: {
      baseUrl,
      endpoint,
      model,
      headers,
      outputDimensionality,
    },
  };
}
