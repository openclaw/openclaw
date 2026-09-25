import { z } from "zod";
import type { GatewayConfig } from "../config/types.gateway.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";

const referenceSchema = z.strictObject({ version: z.literal(1), id: z.uuid() });

export type UserChannelAuthorizationReference = Readonly<z.infer<typeof referenceSchema>>;
export type UserChannelAuthorization = {
  reference: UserChannelAuthorizationReference;
  subject: string;
  grant: GatewayAccessGrantRef | null;
};

export function parseUserChannelAuthorizationReference(value: unknown) {
  return referenceSchema.safeParse(value).data;
}

export function resolveUserChannelAuthorizationPolicy(
  gateway: Pick<GatewayConfig, "roles" | "auth"> | undefined,
) {
  return { roles: gateway?.roles ?? null, identityScopes: gateway?.auth?.identityScopes ?? null };
}

export type UserChannelAuthorizationPolicy = ReturnType<
  typeof resolveUserChannelAuthorizationPolicy
>;
