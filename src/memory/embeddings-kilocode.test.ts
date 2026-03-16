import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import {
  DEFAULT_KILOCODE_EMBEDDING_MODEL,
  normalizeKilocodeModel,
  resolveKilocodeEmbeddingClient,
} from "./embeddings-kilocode.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";

describe("normalizeKilocodeModel", () => {
  it("returns the default model for empty values", () => {
    expect(normalizeKilocodeModel("")).toBe(DEFAULT_KILOCODE_EMBEDDING_MODEL);
    expect(normalizeKilocodeModel("   ")).toBe(DEFAULT_KILOCODE_EMBEDDING_MODEL);
  });

  it("strips the kilocode/ prefix", () => {
    expect(normalizeKilocodeModel("kilocode/openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
    expect(normalizeKilocodeModel("  kilocode/mistralai/mistral-embed  ")).toBe(
      "mistralai/mistral-embed",
    );
  });

  it("keeps non-prefixed models including sub-provider prefixes", () => {
    expect(normalizeKilocodeModel("mistralai/mistral-embed")).toBe("mistralai/mistral-embed");
    expect(normalizeKilocodeModel("openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
    expect(normalizeKilocodeModel("custom-embed-v2")).toBe("custom-embed-v2");
  });
});

function buildEmbeddingOptions(overrides?: {
  apiKey?: string;
  model?: string;
  providerHeaders?: Record<string, string>;
  providerOrganizationId?: string;
  remoteOrganizationId?: string;
  remoteHeaders?: Record<string, string>;
}): EmbeddingProviderOptions {
  const hasProviderConfig = overrides?.providerHeaders || overrides?.providerOrganizationId;
  return {
    config: {
      models: hasProviderConfig
        ? {
            providers: {
              kilocode: {
                baseUrl: "https://api.kilo.ai/api/gateway/",
                models: [],
                headers: overrides?.providerHeaders,
                organizationId: overrides?.providerOrganizationId,
              },
            },
          }
        : undefined,
    } as unknown as OpenClawConfig,
    provider: "kilocode",
    model: overrides?.model ?? DEFAULT_KILOCODE_EMBEDDING_MODEL,
    fallback: "none",
    // Use remote.apiKey to bypass the auth chain in tests
    remote: {
      apiKey: overrides?.apiKey ?? "test-api-key",
      organizationId: overrides?.remoteOrganizationId,
      headers: overrides?.remoteHeaders,
    },
  };
}

describe("resolveKilocodeEmbeddingClient: org ID header", () => {
  const envSnapshot = captureEnv(["KILOCODE_ORG_ID"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("includes X-KILOCODE-ORGANIZATIONID header when KILOCODE_ORG_ID env var is set", async () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(buildEmbeddingOptions());
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("env-org-999");
  });

  it("omits X-KILOCODE-ORGANIZATIONID header when KILOCODE_ORG_ID is not set", async () => {
    delete process.env.KILOCODE_ORG_ID;
    const client = await resolveKilocodeEmbeddingClient(buildEmbeddingOptions());
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBeUndefined();
  });

  it("uses provider config header over env var for org ID", async () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        providerHeaders: { "X-KILOCODE-ORGANIZATIONID": "config-org-456" },
      }),
    );
    // Config takes precedence — but headerOverrides apply first in the spread,
    // then the orgId injection is appended. Since the config header is already
    // in headerOverrides and then orgId resolves from config (same value), result
    // should be the config value.
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("config-org-456");
  });

  it("uses remote.organizationId as highest-priority override over env var", async () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({ remoteOrganizationId: "remote-org-111" }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("remote-org-111");
  });

  it("uses remote.organizationId as highest-priority override over config header", async () => {
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        providerHeaders: { "X-KILOCODE-ORGANIZATIONID": "config-org-456" },
        remoteOrganizationId: "remote-org-111",
      }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("remote-org-111");
  });

  it("ignores empty remote.organizationId and falls back to env var", async () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({ remoteOrganizationId: "   " }),
    );
    // Whitespace-only value trims to empty — should fall through to env var
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("env-org-999");
  });

  it("uses provider config organizationId field over env var", async () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({ providerOrganizationId: "provider-org-777" }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("provider-org-777");
  });

  it("uses provider config organizationId field over header", async () => {
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        providerOrganizationId: "provider-org-777",
        providerHeaders: { "X-KILOCODE-ORGANIZATIONID": "header-org-456" },
      }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("provider-org-777");
  });

  it("remote.organizationId overrides provider config organizationId field", async () => {
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        providerOrganizationId: "provider-org-777",
        remoteOrganizationId: "remote-org-111",
      }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("remote-org-111");
  });

  it("remote.headers org ID takes precedence over KILOCODE_ORG_ID env var (WARNING fix)", async () => {
    // If a user explicitly sets X-KILOCODE-ORGANIZATIONID in remote.headers, it must not be
    // overwritten by the KILOCODE_ORG_ID env var. The env var is a global default; an
    // explicit header override is more specific.
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        remoteHeaders: { "X-KILOCODE-ORGANIZATIONID": "remote-header-org" },
      }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("remote-header-org");
  });

  it("remote.organizationId takes precedence over remote.headers org ID", async () => {
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        remoteOrganizationId: "remote-field-org",
        remoteHeaders: { "X-KILOCODE-ORGANIZATIONID": "remote-header-org" },
      }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("remote-field-org");
  });

  it("whitespace-only remote.headers org ID falls through to env var", async () => {
    process.env.KILOCODE_ORG_ID = "env-org-999";
    const client = await resolveKilocodeEmbeddingClient(
      buildEmbeddingOptions({
        remoteHeaders: { "X-KILOCODE-ORGANIZATIONID": "   " },
      }),
    );
    expect(client.headers["X-KILOCODE-ORGANIZATIONID"]).toBe("env-org-999");
  });
});
