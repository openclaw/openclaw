import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { isBuiltInModelProviderOverlayId } from "../../config/model-provider-overlay-ids.js";
import { collectBaseArrayPaths } from "../../config/patch-replace-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelsConfigSchema } from "../../config/zod-schema.core.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { CUSTOM_ENDPOINT_APIS, customEndpointModelInputs } from "../../shared/custom-endpoint.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type AuthoredModels = NonNullable<z.input<typeof ModelsConfigSchema>>;
type AuthoredProvider = NonNullable<AuthoredModels["providers"]>[string];
type AuthoredModel = NonNullable<AuthoredProvider["models"]>[number];
type EndpointSourceConfig = Omit<OpenClawConfig, "models"> & { models?: AuthoredModels };

const connection = {
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
        );
      } catch {
        return false;
      }
    }, "Use an HTTP(S) base URL without embedded credentials."),
  api: z.enum(CUSTOM_ENDPOINT_APIS),
  noAuth: z.boolean(),
};
const model = z
  .object({
    id: z.string().trim().min(1),
    existingId: z.string().min(1).optional(),
    edits: z
      .object({
        name: z.string().trim().min(1).optional(),
        textInput: z.boolean().optional(),
        imageInput: z.boolean().optional(),
        reasoning: z.boolean().optional(),
        contextWindow: z.number().int().positive().nullable().optional(),
        maxTokens: z.number().int().positive().nullable().optional(),
      })
      .strict(),
  })
  .strict();
const target = { provider: z.string().min(1), baseHash: z.string().min(1) };
export const customEndpointParams = z.discriminatedUnion("action", [
  z
    .object({
      ...target,
      ...connection,
      action: z.enum(["create", "edit"]),
      models: z.array(model).min(1),
    })
    .strict(),
  z.object({ ...target, action: z.literal("delete") }).strict(),
  z
    .object({
      provider: z.string().min(1),
      ...connection,
      action: z.literal("discover"),
      apiKey: z.string().optional(),
      agentId: z.string().optional(),
    })
    .strict(),
]);
export type CustomEndpointParams = z.infer<typeof customEndpointParams>;

/** Plugin identity is never repurposed as an independent custom endpoint. */
export function assertIndependentEndpoint(provider: string, metadata?: PluginMetadataSnapshot) {
  const normalized = provider.trim().toLowerCase();
  if (
    isBuiltInModelProviderOverlayId(normalized) ||
    metadata?.plugins.some(
      (plugin) =>
        plugin.providers?.some((id) => id.trim().toLowerCase() === normalized) ||
        Object.keys(plugin.providerAuthAliases ?? {}).some(
          (id) => id.trim().toLowerCase() === normalized,
        ),
    )
  ) {
    throw new Error("This provider belongs to an integration. Use its existing provider setup.");
  }
}

/** Configured references must be resolved explicitly, never silently rewritten on removal. */
function customEndpointReferences(
  config: unknown,
  provider: string,
  removed?: Set<string>,
): string[] {
  return collectConfiguredModelRefs(config).flatMap((ref) => {
    const parsed = parseModelCatalogRef(
      ref.kind === "selector" ? splitTrailingAuthProfile(ref.value).model : ref.value,
    );
    return parsed?.provider === provider && (!removed || removed.has(parsed.modelId))
      ? [ref.path]
      : [];
  });
}

/** Runs inside the config writer, against its exact authored CAS snapshot. */
export function prepareCustomEndpointPatch(
  params: Exclude<CustomEndpointParams, { action: "discover" }>,
  source: EndpointSourceConfig,
  metadata?: PluginMetadataSnapshot,
) {
  const { provider } = params;
  assertIndependentEndpoint(provider, metadata);
  const providers = source.models?.providers ?? {};
  const existing = providers[provider];
  if (
    params.action === "create" &&
    (provider !== provider.trim().toLowerCase() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider))
  ) {
    throw new Error("Use a lowercase provider ID containing letters, numbers, and hyphens.");
  }
  if (
    params.action === "create"
      ? Object.keys(providers).some((id) => id.trim().toLowerCase() === provider)
      : !existing
  ) {
    throw new Error(
      params.action === "create"
        ? "This provider ID already exists. Choose a distinct ID."
        : "This endpoint no longer exists. Refresh before editing.",
    );
  }
  if (existing?.api && !CUSTOM_ENDPOINT_APIS.some((api) => api === existing.api)) {
    throw new Error(
      "This adapter is not supported by the endpoint editor. Use configuration settings.",
    );
  }
  const removed =
    params.action === "delete"
      ? undefined
      : new Set(
          (existing?.models ?? [])
            .filter((entry) => !params.models.some((row) => row.id === entry.id))
            .map((entry) => entry.id),
        );
  const references = customEndpointReferences(source, provider.trim().toLowerCase(), removed);
  if (references.length) {
    throw new Error(
      "Resolve configured model references before removing them: " + references.join(", "),
    );
  }
  let value: Record<string, unknown> | null = null;
  if (params.action !== "delete") {
    if (new Set(params.models.map((row) => row.id)).size !== params.models.length) {
      throw new Error("Model IDs must be unique within an endpoint.");
    }
    const existingIds = params.models.flatMap((row) => (row.existingId ? [row.existingId] : []));
    if (new Set(existingIds).size !== existingIds.length) {
      throw new Error("An existing model can only be edited once.");
    }
    const models = params.models.map((row): AuthoredModel => {
      const previous = row.existingId
        ? existing?.models?.find((entry) => entry.id === row.existingId)
        : undefined;
      if (row.existingId && !previous) {
        throw new Error("This model no longer exists. Refresh before editing.");
      }
      if (existing?.models?.some((entry) => entry.id === row.id && entry.id !== row.existingId)) {
        throw new Error("This model ID already belongs to another model.");
      }
      const name = row.edits.name ?? previous?.name;
      if (!name) {
        throw new Error("Enter a display name for each new model.");
      }
      const next: AuthoredModel = { ...previous, id: row.id, name };
      if (row.edits.reasoning !== undefined) {
        next.reasoning = row.edits.reasoning;
      }
      for (const field of ["contextWindow", "maxTokens"] as const) {
        if (row.edits[field] === null) {
          delete next[field];
        } else if (row.edits[field] !== undefined) {
          next[field] = row.edits[field];
        }
      }
      if (row.edits.textInput !== undefined || row.edits.imageInput !== undefined) {
        next.input = customEndpointModelInputs(previous?.input, row.edits);
      }
      return next;
    });
    if (params.noAuth && models.some((row) => (row.api ?? params.api) !== "openai-completions")) {
      throw new Error(
        "No authentication is supported only for effective Chat Completions routes, including model overrides.",
      );
    }
    value = {
      ...existing,
      baseUrl: params.baseUrl,
      api: params.api,
      models,
      ...(params.noAuth ? { auth: "none" } : existing?.auth === "none" ? { auth: null } : {}),
    };
  }
  return {
    raw: JSON.stringify({ models: { providers: { [provider]: value } } }),
    replacePaths:
      params.action === "delete"
        ? collectBaseArrayPaths(existing, "models.providers." + provider)
        : [
            "models.providers." + provider + ".models",
            // A checkbox can intentionally remove a modality from a model's input array.
            ...(params.models.some(
              (row) => row.edits.textInput !== undefined || row.edits.imageInput !== undefined,
            )
              ? ["models.providers." + provider + ".models[].input"]
              : []),
          ],
    baseHash: params.baseHash,
  };
}

/** Admission/discovery stays here; all persistence runs through the injected config owner. */
export function createCustomEndpointHandler(
  write: (
    options: GatewayRequestHandlerOptions,
    params: Exclude<CustomEndpointParams, { action: "discover" }>,
  ) => Promise<void>,
): GatewayRequestHandler {
  return async (options) => {
    const { client, respond, context } = options;
    // Match custom setup's verified server-side locality boundary, never a browser hint.
    if (client?.internal?.isLocalClient !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Custom endpoints can only be managed from a local connection on the Gateway host. Remote custom setup is not supported.",
        ),
      );
      return;
    }
    const parsed = customEndpointParams.safeParse(options.params);
    if (!parsed.success) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsed.error.message));
      return;
    }
    const params = parsed.data;
    if (params.action !== "discover") {
      await write(options, params);
      return;
    }
    try {
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const config = context.getRuntimeConfig();
      const { loadManifestMetadataSnapshot } =
        await import("../../plugins/manifest-contract-eligibility.js");
      authority.assertCurrent();
      assertIndependentEndpoint(params.provider, loadManifestMetadataSnapshot({ config }));
      if (params.api === "anthropic-messages") {
        throw new Error("Discovery is not qualified for Anthropic. Enter model IDs manually.");
      }
      if (params.noAuth && params.api !== "openai-completions") {
        throw new Error("No authentication requires Chat Completions.");
      }
      const { discoverCustomApiModelIds } = await import("../../commands/onboard-custom-config.js");
      authority.assertCurrent();
      const models = await discoverCustomApiModelIds({
        baseUrl: params.baseUrl,
        ...(params.noAuth ? {} : { apiKey: params.apiKey }),
      });
      authority.assertCurrent();
      respond(true, { models, inferenceTested: false }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  };
}
