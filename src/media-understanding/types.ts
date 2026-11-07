import type { ImagesDescriptionInput } from "../../packages/media-understanding-common/src/types.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.types.js";

export type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingCapabilityRegistry,
} from "../../packages/media-understanding-common/src/types.js";

export type MediaUnderstandingProviderRequestAuth =
  | { kind: "api-key"; apiKey: string; source?: string }
  | { kind: "none"; source: string };

export type AudioTranscriptionRequest = MediaUnderstandingProviderRequest & {
  language?: string;
  query?: Record<string, string | number | boolean | string[]>;
};

type MediaUnderstandingProviderRequest = ImagesDescriptionInput & {
  /** Compatibility field for existing providers; prefer auth.kind/apiKey. */
  apiKey: string;
  auth?: MediaUnderstandingProviderRequestAuth;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ModelProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
};

export type VideoDescriptionRequest = MediaUnderstandingProviderRequest;

export type MediaUnderstandingProviderAuthResult =
  | { kind: "none"; source: string }
  | { kind: "api-key"; apiKey: string; source: string; mode?: "api-key" };

export type MediaUnderstandingProviderSyntheticAuthResult = {
  apiKey: string;
  source: string;
  mode: "api-key";
};
