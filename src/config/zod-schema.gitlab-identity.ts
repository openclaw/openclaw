import { z } from "zod";
import { MANAGED_GITLAB_PROFILE_ID_PATTERN } from "./gitlab-identity-profile-id.js";

const fields = {
  profileId: z.string().regex(MANAGED_GITLAB_PROFILE_ID_PATTERN),
  issuer: z.url({ protocol: /^https$/ }).refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === value && url.pathname === "/" && !url.hostname.endsWith(".");
    } catch {
      return false;
    }
  }),
};

export const GitLabToolIdentitySchema = z.strictObject(fields).optional();
export const AgentGitLabToolIdentitySchema = z
  .strictObject({ ...fields, allowInSandbox: z.boolean().optional() })
  .optional();
