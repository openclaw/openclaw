import type { M365EmailTransformResult } from "./m365-email.js";
import { transformM365EmailPayload } from "./m365-email.js";
import type { OwnerRezTransformResult } from "./ownerrez.js";
import { transformOwnerRezPayload } from "./ownerrez.js";
import type { QuickBooksTransformResult } from "./quickbooks.js";
import { transformQuickBooksPayload } from "./quickbooks.js";
import type { ReadAiTransformResult } from "./readai.js";
import { transformReadAiPayload } from "./readai.js";
import type { ShopifyTransformResult } from "./shopify.js";
import { transformShopifyPayload } from "./shopify.js";

export type WebhookTransformResult = {
  message: string;
  name: string;
  sessionKey: string;
} | null;

export type WebhookTransformFn = (payload: Record<string, unknown>) => WebhookTransformResult;

const webhookTransforms: Record<string, WebhookTransformFn> = {
  readai: transformReadAiPayload as WebhookTransformFn,
  quickbooks: transformQuickBooksPayload as WebhookTransformFn,
  ownerrez: transformOwnerRezPayload as WebhookTransformFn,
  shopify: transformShopifyPayload as WebhookTransformFn,
  "m365-email": transformM365EmailPayload as WebhookTransformFn,
};

export function getWebhookTransform(source: string): WebhookTransformFn | undefined {
  return webhookTransforms[source];
}

export type {
  M365EmailTransformResult,
  OwnerRezTransformResult,
  QuickBooksTransformResult,
  ReadAiTransformResult,
  ShopifyTransformResult,
};
