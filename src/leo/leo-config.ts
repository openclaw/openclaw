import { z } from "zod";
import type { LeoIdentityConfig } from "./types.js";

const GoogleWorkspaceSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  email: z.string().min(1),
});

const SlackSchema = z.object({
  bot_token: z.string().min(1),
  workspace_id: z.string().min(1),
});

const AsanaSchema = z.object({
  pat: z.string().min(1),
  workspace_gid: z.string().min(1),
});

const MondaySchema = z.object({
  api_token: z.string().min(1),
});

const GitHubSchema = z.object({
  pat: z.string().min(1),
  org_name: z.string().min(1),
});

const OrgSchema = z.object({
  google_workspace: GoogleWorkspaceSchema,
  slack: SlackSchema.optional(),
  asana: AsanaSchema.optional(),
  monday: MondaySchema.optional(),
  github: GitHubSchema.optional(),
});

const IdentitySchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  owner_name: z.string().min(1),
});

const LeoConfigSchema = z.object({
  identity: IdentitySchema,
  orgs: z
    .record(z.string(), OrgSchema)
    .refine((orgs) => Object.keys(orgs).length > 0, { message: "orgs must have at least 1 entry" }),
});

export function parseLeoConfig(input: unknown): LeoIdentityConfig {
  return LeoConfigSchema.parse(input);
}
