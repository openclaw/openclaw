import express, { type Request, type Response } from "express";
import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatEvent } from "./types.js";

export type GoogleChatWebhookOptions = {
  account: ResolvedGoogleChatAccount;
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  port?: number;
  onMessage?: (event: GoogleChatEvent) => Promise<void>;
};

export type NormalizedGoogleChatMessage = {
  provider: "googlechat";
  accountId: string;
  messageId: string;
  timestamp: number;
  sender: {
    id: string;
    name: string;
    email?: string;
  };
  chat: {
    id: string;
    name: string;
    type: "dm" | "group";
  };
  thread?: {
    id: string;
  };
  content: {
    text: string;
  };
  raw: GoogleChatEvent;
};

function normalizeMessage(
  event: GoogleChatEvent,
  accountId: string,
): NormalizedGoogleChatMessage | null {
  if (event.type !== "MESSAGE" || !event.message) {
    return null;
  }

  const msg = event.message;

  // Skip messages from bots
  if (msg.sender.type === "BOT") {
    return null;
  }

  const spaceId = msg.space.name.replace("spaces/", "");
  const isDM = msg.space.type === "DM";

  return {
    provider: "googlechat",
    accountId,
    messageId: msg.name,
    timestamp: new Date(msg.createTime).getTime(),
    sender: {
      id: msg.sender.name.replace("users/", ""),
      name: msg.sender.displayName,
      email: msg.sender.email,
    },
    chat: {
      id: spaceId,
      name: msg.space.displayName || spaceId,
      type: isDM ? "dm" : "group",
    },
    thread: msg.thread
      ? {
          id: msg.thread.name,
        }
      : undefined,
    content: {
      text: msg.argumentText || msg.text || "",
    },
    raw: event,
  };
}

export async function startGoogleChatWebhookServer(
  options: GoogleChatWebhookOptions,
): Promise<{
  server: ReturnType<typeof express>;
  port: number;
  stop: () => void;
}> {
  const { account, port = 18792 } = options;

  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      provider: "googlechat",
      accountId: account.accountId,
    });
  });

  // Google Chat webhook endpoint
  app.post("/webhook/googlechat", async (req: Request, res: Response) => {
    try {
      const event = req.body as GoogleChatEvent;

      console.log(
        `[googlechat:${account.accountId}] Received event: ${event.type}`,
      );

      // Handle different event types
      if (event.type === "ADDED_TO_SPACE") {
        // Bot was added to a space
        res.json({
          text: "Hello! I'm Clawdbot, your personal AI assistant. Send me a message to get started!",
        });
        return;
      }

      if (event.type === "MESSAGE") {
        const normalized = normalizeMessage(event, account.accountId);

        if (normalized) {
          console.log(
            `[googlechat:${account.accountId}] Message from ${normalized.sender.name}: ${normalized.content.text.slice(0, 50)}...`,
          );

          // Call the message handler if provided
          if (options.onMessage) {
            await options.onMessage(event);
          }

          // For now, echo back a confirmation
          // In full integration, this would route to the agent
          res.json({
            text: `Got your message! (Clawdbot Google Chat integration is working)\n\nYou said: "${normalized.content.text}"`,
          });
          return;
        }
      }

      // Default response for other events
      res.json({});
    } catch (error) {
      console.error(`[googlechat:${account.accountId}] Webhook error:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Start server
  const server = app.listen(port, () => {
    console.log(
      `[googlechat:${account.accountId}] Webhook server listening on port ${port}`,
    );
    console.log(
      `[googlechat:${account.accountId}] Webhook URL: http://localhost:${port}/webhook/googlechat`,
    );
  });

  const stop = () => {
    server.close();
    console.log(`[googlechat:${account.accountId}] Webhook server stopped`);
  };

  return { server: app, port, stop };
}
