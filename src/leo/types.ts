export type LeoIdentityConfig = {
  identity: {
    name: string;
    role: string;
    owner_name: string;
  };
  orgs: Record<string, LeoOrgConfig>;
};

export type LeoOrgConfig = {
  google_workspace: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    email: string;
  };
  slack?: {
    bot_token: string;
    workspace_id: string;
  };
  asana?: {
    pat: string;
    workspace_gid: string;
  };
  monday?: {
    api_token: string;
  };
  github?: {
    pat: string;
    org_name: string;
  };
};

export type LeoToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
  requireApproval?: boolean;
};
