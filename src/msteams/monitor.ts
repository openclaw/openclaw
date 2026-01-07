import type { ClawdbotConfig } from "../config/types.js";
import { getChildLogger } from "../logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveMSTeamsCredentials } from "./token.js";

const log = getChildLogger({ name: "msteams:monitor" });

export type MonitorMSTeamsOpts = {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const msteamsCfg = opts.cfg.msteams;
  if (!msteamsCfg?.enabled) {
    log.debug("msteams provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    log.error("msteams credentials not configured");
    return { app: null, shutdown: async () => {} };
  }

  const port = msteamsCfg.webhook?.port ?? 3978;
  const path = msteamsCfg.webhook?.path ?? "/msteams/messages";

  log.info(`starting msteams provider on port ${port}${path}`);

  // Dynamic import to avoid loading SDK when provider is disabled
  const agentsHosting = await import("@microsoft/agents-hosting");
  const { startServer } = await import("@microsoft/agents-hosting-express");

  const { ActivityHandler } = agentsHosting;
  type TurnContext = InstanceType<typeof agentsHosting.TurnContext>;

  // Create activity handler using fluent API
  const handler = new ActivityHandler()
    .onMessage(async (context: TurnContext, next: () => Promise<void>) => {
      const text = context.activity?.text?.trim() ?? "";
      const from = context.activity?.from;
      const conversation = context.activity?.conversation;

      log.debug("received message", {
        text: text.slice(0, 100),
        from: from?.id,
        conversation: conversation?.id,
      });

      // TODO: Implement full message handling
      // - Route to agent based on config
      // - Process commands
      // - Send reply via context.sendActivity()

      // Echo for now as a test
      await context.sendActivity(`Received: ${text}`);
      await next();
    })
    .onMembersAdded(async (context: TurnContext, next: () => Promise<void>) => {
      const membersAdded = context.activity?.membersAdded ?? [];
      for (const member of membersAdded) {
        if (member.id !== context.activity?.recipient?.id) {
          log.debug("member added", { member: member.id });
          await context.sendActivity("Hello! I'm Clawdbot.");
        }
      }
      await next();
    });

  // Auth configuration using the new SDK format
  const authConfig = {
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  };

  // Set env vars that startServer reads (it uses loadAuthConfigFromEnv internally)
  process.env.clientId = creds.appId;
  process.env.clientSecret = creds.appPassword;
  process.env.tenantId = creds.tenantId;
  process.env.PORT = String(port);

  // Start the server
  const expressApp = startServer(handler, authConfig);

  log.info(`msteams provider started on port ${port}`);

  const shutdown = async () => {
    log.info("shutting down msteams provider");
    // Express app doesn't have a direct close method
    // The server is managed by startServer internally
  };

  // Handle abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      void shutdown();
    });
  }

  return { app: expressApp, shutdown };
}
