#!/usr/bin/env npx tsx
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request, type Response } from "express";

const PORT = 18793;
const GATEWAY_URL = "http://localhost:18789";
const GATEWAY_TOKEN = "cos-webhook-secret-2026";

const app = express();
app.use(express.json());

// SECURITY: Only these email addresses can send messages to Clawdette
const ALLOWED_SENDERS = [
  "justin@remixpartners.ai",
  "justinmassa@gmail.com", // backup in case GChat uses personal email
];

const PYTHON = "/Users/justinmassa/chief-of-staff/.venv/bin/python";
const GCHAT_SENDER = "/Users/justinmassa/chief-of-staff/scripts/gchat_send_file.py";

// Message queue per space to prevent race conditions
interface QueuedMessage {
  text: string;
  sessionId: string;
  spaceId: string;
}

const messageQueues: Map<string, QueuedMessage[]> = new Map();
const processingSpaces: Set<string> = new Set();

function enqueueMessage(spaceId: string, message: QueuedMessage): void {
  if (!messageQueues.has(spaceId)) {
    messageQueues.set(spaceId, []);
  }
  messageQueues.get(spaceId)!.push(message);
  console.log(
    `[googlechat] Queued message for space ${spaceId} (queue size: ${messageQueues.get(spaceId)!.length})`,
  );
  processQueue(spaceId);
}

function processQueue(spaceId: string): void {
  // If already processing this space, wait
  if (processingSpaces.has(spaceId)) {
    console.log(`[googlechat] Space ${spaceId} busy, message queued`);
    return;
  }

  const queue = messageQueues.get(spaceId);
  if (!queue || queue.length === 0) {
    return;
  }

  // Take the next message
  const message = queue.shift()!;
  processingSpaces.add(spaceId);

  console.log(`[googlechat] Processing message for space ${spaceId}...`);

  runAgent(message.text, message.sessionId, (err, response) => {
    processingSpaces.delete(spaceId);

    if (err) {
      console.error(`[googlechat] AI error:`, err.message);
      sendChatMessage(spaceId, "Sorry, I encountered an error processing your message.");
    } else {
      const responseText = response || "I processed your message but have no response.";
      console.log(
        `[googlechat] AI Response (${responseText.length} chars): ${responseText.slice(0, 100)}...`,
      );
      sendChatMessage(spaceId, responseText);
    }

    // Process next message in queue
    processQueue(spaceId);
  });
}

// Send message via Chat API using temp file (avoids escaping issues)
function sendChatMessage(spaceId: string, text: string): void {
  const tmpFile = join(tmpdir(), `gchat-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, text);

    const proc = spawn(PYTHON, [GCHAT_SENDER, spaceId, tmpFile], {
      timeout: 30000,
    });

    proc.stdout.on("data", (data) => {
      console.log("[googlechat] Message sent:", data.toString().trim());
    });

    proc.stderr.on("data", (data) => {
      console.error("[googlechat] Send stderr:", data.toString().trim());
    });

    proc.on("close", (code) => {
      // Small delay ensures Python has finished reading the file
      setTimeout(() => {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }, 100);
      if (code !== 0) {
        console.error(`[googlechat] Send failed with code ${code}`);
      }
    });

    proc.on("error", (err) => {
      console.error("[googlechat] Send error:", err.message);
      setTimeout(() => {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }, 100);
    });
  } catch (e) {
    console.error("[googlechat] Failed to write temp file:", e);
  }
}

// Run clawdbot agent via gateway hooks API (more reliable than spawning processes)
async function runAgent(
  message: string,
  sessionId: string,
  callback: (err: Error | null, response: string) => void,
): Promise<void> {
  try {
    console.log(`[googlechat] Calling gateway hooks API for session ${sessionId}...`);

    // Call the gateway hooks API instead of spawning a process
    const response = await fetch(`${GATEWAY_URL}/webhook/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        message,
        sessionKey: sessionId,
      }),
      // 10 minute timeout for long-running agent tasks
      signal: AbortSignal.timeout(600000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[googlechat] Gateway returned ${response.status}: ${errorText}`);
      callback(new Error(`Gateway error ${response.status}: ${errorText}`), "");
      return;
    }

    const result = (await response.json()) as {
      ok: boolean;
      runId?: string;
      response?: string;
      error?: string;
    };

    if (!result.ok) {
      console.error(`[googlechat] Gateway error:`, result.error);
      callback(new Error(result.error || "Unknown gateway error"), "");
      return;
    }

    // The hooks API returns the agent's response directly
    const agentResponse = result.response || "";
    callback(null, agentResponse);
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "TimeoutError") {
        console.error(`[googlechat] Gateway request timed out after 10 minutes`);
        callback(new Error("Request timed out - the AI took too long to respond"), "");
      } else {
        console.error(`[googlechat] Gateway request failed:`, err.message);
        callback(err, "");
      }
    } else {
      callback(new Error("Unknown error"), "");
    }
  }
}

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, provider: "googlechat" });
});

// Google Chat webhook
app.post("/webhook/googlechat", async (req: Request, res: Response) => {
  try {
    const event = req.body;
    const chat = event.chat || {};

    const isAddedToSpace = !!chat.addedToSpacePayload;
    const isMessage = !!chat.messagePayload;

    const eventType = isAddedToSpace ? "ADDED_TO_SPACE" : isMessage ? "MESSAGE" : "UNKNOWN";
    console.log(`[googlechat] Received event: ${eventType}`);

    if (isAddedToSpace) {
      const user = chat.user?.displayName || "there";
      res.json({
        hostAppDataAction: {
          chatDataAction: {
            createMessageAction: {
              message: {
                text: `Hello ${user}! I'm Clawdette, your AI assistant. Send me a message and I'll respond!`,
              },
            },
          },
        },
      });
      return;
    }

    if (isMessage) {
      const msg = chat.messagePayload.message;
      const senderName = msg?.sender?.displayName || "Unknown";
      const senderEmail = msg?.sender?.email || "";
      const text = msg?.argumentText || msg?.text || "";
      const spaceId = msg?.space?.name?.replace("spaces/", "") || "default";

      console.log(`[googlechat] Message from ${senderName} <${senderEmail}>: ${text}`);

      // SECURITY: Reject messages from unauthorized senders
      if (!ALLOWED_SENDERS.includes(senderEmail.toLowerCase())) {
        console.log(`[googlechat] BLOCKED: Unauthorized sender ${senderEmail}`);
        res.json({}); // Acknowledge but don't process
        return;
      }

      // Acknowledge immediately - no blocking!
      res.json({});

      const sessionId = `googlechat:${spaceId}`;

      // Queue the message instead of processing immediately
      enqueueMessage(spaceId, { text, sessionId, spaceId });

      return;
    }

    res.json({});
  } catch (error) {
    console.error("[googlechat] Error:", error);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`[googlechat] Webhook server running on port ${PORT}`);
  console.log(`[googlechat] Mode: Gateway hooks API (no process spawning)`);
  console.log(`[googlechat] Gateway: ${GATEWAY_URL}`);
});
