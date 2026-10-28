import { z } from "zod";

const timestamp = z.number().int().nonnegative().finite();
const secret = z.string().min(1).max(16384);
export const gitLabIssuerSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    const canonical = url.origin + (url.pathname === "/" ? "" : url.pathname);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !canonical.endsWith("/") &&
      canonical === value
    );
  } catch {
    return false;
  }
}, "GitLab issuer must be a canonical HTTPS URL without a trailing slash");

const tokens = z.strictObject({
  accessToken: secret,
  refreshToken: secret,
  expiresAtMs: timestamp,
  scopes: z.array(z.string().min(1).max(128)).max(32),
});
const account = z.strictObject({
  accountId: z.number().int().positive(),
  login: z.string().min(1).max(256),
  name: z.string().max(512).optional(),
  commitEmail: z.email().max(512).optional(),
  issuer: gitLabIssuerSchema,
});
const connected = z.strictObject({
  kind: z.literal("connected"),
  account,
  tokens,
  refresh: z.strictObject({ operationId: z.uuid() }).optional(),
  refreshFailure: z.enum(["failed", "expired"]).optional(),
});
const pending = z.strictObject({
  requestId: z.uuid(),
  state: secret,
  verifier: secret,
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
  configFingerprint: z.string().min(1).max(256).optional(),
});

export const userGitLabConnectionSchema = z
  .strictObject({
    version: z.literal(1),
    generation: z.uuid(),
    issuer: gitLabIssuerSchema,
    selection: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("disconnected") }),
      connected,
    ]),
    pending: pending.optional(),
  })
  .superRefine((record, ctx) => {
    if (
      record.selection.kind === "connected" &&
      record.selection.account.issuer !== record.issuer
    ) {
      ctx.addIssue({
        code: "custom",
        message: "GitLab account issuer differs from connection issuer",
      });
    }
    if (record.pending && record.pending.expiresAtMs <= record.pending.createdAtMs) {
      ctx.addIssue({ code: "custom", message: "Invalid GitLab authorization timing" });
    }
  });

export type UserGitLabConnection = z.infer<typeof userGitLabConnectionSchema>;
export type UserGitLabConnected = z.infer<typeof connected>;
export type UserGitLabTokens = z.infer<typeof tokens>;
export type UserGitLabAccount = z.infer<typeof account>;
export type UserGitLabPending = z.infer<typeof pending>;

export const userGitLabConnectionCommitSchema = z.strictObject({
  kind: z.literal("user-gitlab-connection"),
  changed: z.array(z.strictObject({ owner: z.string(), issuer: gitLabIssuerSchema })),
});
export type UserGitLabConnectionCommit = z.infer<typeof userGitLabConnectionCommitSchema>;
