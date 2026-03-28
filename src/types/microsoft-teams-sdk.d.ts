declare module "@microsoft/teams.apps" {
  export class App {
    constructor(options: { clientId: string; clientSecret: string; tenantId?: string });

    getBotToken(): Promise<{ toString(): string } | null>;
    getAppGraphToken(): Promise<{ toString(): string } | null>;
  }
}

declare module "@microsoft/teams.api" {
  export class Client {
    constructor(
      serviceUrl: string,
      options?: {
        token?: (() => Promise<string | undefined>) | undefined;
        headers?: Record<string, string> | undefined;
      },
    );

    conversations: {
      activities: (conversationId: string) => {
        create: (activity: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }
}

declare module "@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js" {
  export type JwtValidationOptions = {
    clientId: string;
    tenantId?: string;
    jwksUriOptions: { type: "uri"; uri: string } | { type: "tenantId" };
    validateIssuer?: { allowedIssuer: string } | { allowedTenantIds?: string[] };
    validateServiceUrl?: { expectedServiceUrl: string };
  };

  export class JwtValidator {
    constructor(options: JwtValidationOptions, logger?: unknown);
    validateAccessToken(
      token: string,
      options?: {
        validateServiceUrl?: { expectedServiceUrl: string } | undefined;
      },
    ): Promise<unknown | null>;
  }

  export function createServiceTokenValidator(
    appId: string,
    tenantId?: string,
  ): {
    validateAccessToken(
      token: string,
      options?: {
        validateServiceUrl?: { expectedServiceUrl: string } | undefined;
      },
    ): Promise<unknown>;
  };
}
