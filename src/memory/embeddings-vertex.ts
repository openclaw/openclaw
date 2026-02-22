import { GoogleAuth } from "google-auth-library";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type VertexEmbeddingClient = {
  projectId: string;
  location: string;
  modelId: string;
  auth: GoogleAuth;
};

export const DEFAULT_VERTEX_EMBEDDING_MODEL = "text-embedding-004";
const debugEmbeddings = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_MEMORY_EMBEDDINGS);
const log = createSubsystemLogger("memory/embeddings-vertex");

const debugLog = (message: string, meta?: Record<string, unknown>) => {
  if (!debugEmbeddings) {
    return;
  }
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  log.raw(`${message}${suffix}`);
};

function normalizeVertexModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_VERTEX_EMBEDDING_MODEL;
  }
  const withoutPrefix = trimmed.replace(/^google-vertex\//, "");
  return withoutPrefix || DEFAULT_VERTEX_EMBEDDING_MODEL;
}

export async function createVertexEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: VertexEmbeddingClient }> {
  const client = await resolveVertexEmbeddingClient(options);

  const getAccessToken = async () => {
    const token = await client.auth.getAccessToken();
    if (!token) {
      throw new Error("Failed to get Vertex AI access token. Check your credentials.");
    }
    return token;
  };

  const predictUrl = `https://${client.location}-aiplatform.googleapis.com/v1/projects/${client.projectId}/locations/${client.location}/publishers/google/models/${client.modelId}:predict`;

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const token = await getAccessToken();
    debugLog("embedding query", { model: client.modelId, location: client.location });

    const res = await fetch(predictUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        instances: [{ task_type: "RETRIEVAL_QUERY", content: text }],
      }),
    });

    if (!res.ok) {
      const payload = await res.text();
      throw new Error(`vertex embeddings failed: ${res.status} ${payload}`);
    }
    const payload = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };
    return payload.predictions?.[0]?.embeddings?.values ?? [];
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const token = await getAccessToken();
    debugLog("embedding batch", { count: texts.length, model: client.modelId });

    const instances = texts.map((text) => ({
      task_type: "RETRIEVAL_DOCUMENT",
      content: text,
    }));

    const res = await fetch(predictUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ instances }),
    });

    if (!res.ok) {
      const payload = await res.text();
      throw new Error(`vertex embeddings failed: ${res.status} ${payload}`);
    }
    const payload = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };
    const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
    return texts.map((_, index) => predictions[index]?.embeddings?.values ?? []);
  };

  return {
    provider: {
      id: "google-vertex",
      model: `google-vertex/${client.modelId}`,
      embedQuery,
      embedBatch,
    },
    client,
  };
}

export async function resolveVertexEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<VertexEmbeddingClient> {
  const env = (options.config.env || {}) as Record<string, unknown>;
  const projectId = (env.GOOGLE_CLOUD_PROJECT as string) || process.env.GOOGLE_CLOUD_PROJECT;

  // Prioritize memorySearch.remote.location, then env, then default to us-central1
  let location =
    options.remote?.location ||
    (env.GOOGLE_CLOUD_LOCATION as string) ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    "us-central1";

  // Embeddings are not available in 'global' region.
  if (location === "global") {
    location = "us-central1";
  }

  if (!projectId) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT is required for vertex embeddings. Set it in agents.defaults.env or environment variables.",
    );
  }

  const modelId = normalizeVertexModel(options.model);

  // Manually handle the auth using google-auth-library to ensure we get a valid access token
  // from the service account key provided in the config.
  const auth = new GoogleAuth({
    keyFile:
      (env.GOOGLE_APPLICATION_CREDENTIALS as string) || process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });

  return { projectId, location, modelId, auth };
}
