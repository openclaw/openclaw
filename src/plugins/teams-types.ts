import type { OpenClawPluginToolContext } from "./tool-types.js";

export type OpenClawPluginTeamsRequestContext = Readonly<{
  isolationDomainId: string;
  principal: Readonly<{
    id: string;
    kind: "human" | "agent";
  }>;
  delegatedSession?: Readonly<{
    id: string;
    assignmentId: string;
    sponsorPrincipalId: string;
  }>;
  requestId: string;
}>;

export type OpenClawPluginTeamsToolCallContext = Readonly<{
  callId: string;
}>;

export type OpenClawPluginTeamsResourceRef = Readonly<{
  namespace: string;
  type: string;
  id: string;
}>;

export type OpenClawPluginTeamsApi = {
  context: {
    /** Resolve only the current host-authorized request; no identity fields are accepted. */
    require: {
      (): OpenClawPluginTeamsRequestContext;
      (toolContext: OpenClawPluginToolContext): OpenClawPluginTeamsToolCallContext;
    };
  };
  authorization: {
    decide: (input: {
      context: OpenClawPluginTeamsToolCallContext;
      permission: string;
      resources: readonly OpenClawPluginTeamsResourceRef[];
    }) => Promise<
      { allowed: true; context: OpenClawPluginTeamsRequestContext } | { allowed: false }
    >;
  };
  resources: {
    prepareRegister: (input: {
      context: OpenClawPluginTeamsRequestContext;
      resource: OpenClawPluginTeamsResourceRef;
      parent?: OpenClawPluginTeamsResourceRef;
      requiredAction: string;
      idempotencyKey: string;
    }) => Promise<string>;
    prepareRetire: (input: {
      context: OpenClawPluginTeamsRequestContext;
      resource: OpenClawPluginTeamsResourceRef;
      requiredAction: string;
      idempotencyKey: string;
    }) => Promise<string>;
    replayPrepared: (input: { operation: string }) => Promise<void>;
    owner: (input: {
      context: OpenClawPluginTeamsRequestContext;
      resource: OpenClawPluginTeamsResourceRef;
    }) => Promise<{ principalId: string }>;
  };
};
