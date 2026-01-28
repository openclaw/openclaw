#!/usr/bin/env npx tsx
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request, type Response } from "express";

const PORT = 18793;
// Increased timeout to 10 minutes (Anthropic API can take a while for complex tasks)
const AGENT_TIMEOUT_MS = 600000;
// Retry configuration for transient failures
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

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

// Helper to delay execution
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run clawdbot agent with retry logic for transient failures
function runAgent(
  message: string,
  sessionId: string,
  callback: (err: Error | null, response: string) => void,
  attempt = 1,
): void {
  console.log(
    `[googlechat] Running agent (attempt ${attempt}/${MAX_RETRIES + 1}) for session ${sessionId}...`,
  );

  const proc = spawn(
    "clawdbot",
    ["agent", "--message", message, "--session-id", sessionId, "--local"],
    {
      timeout: AGENT_TIMEOUT_MS,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    },
  );

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  proc.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  proc.on("close", (code) => {
    // Filter out ANSI-coded log lines that leak from the agent
    const filtered = stdout
      .split("\n")
      .filter((line) => !line.match(/^\x1b\[\d+m\[/))
      .join("\n")
      .trim();

    // Check for retryable errors (rate limits, timeouts)
    const isRetryable =
      stderr.includes("rate_limit") ||
      stderr.includes("overloaded") ||
      stderr.includes("timeout") ||
      stderr.includes("ETIMEDOUT");

    if (filtered) {
      // Got a response - success
      if (code !== 0) {
        console.log(`[googlechat] Agent exited with code ${code} but had response - using it`);
      }
      callback(null, filtered);
    } else if (code !== 0 && isRetryable && attempt <= MAX_RETRIES) {
      // Retryable error - try again after delay
      console.log(`[googlechat] Retryable error detected, retrying in ${RETRY_DELAY_MS}ms...`);
      setTimeout(() => {
        runAgent(message, sessionId, callback, attempt + 1);
      }, RETRY_DELAY_MS);
    } else if (code !== 0) {
      // Non-retryable error or max retries exceeded
      console.error(
        `[googlechat] Agent failed after ${attempt} attempt(s): ${stderr.slice(0, 500)}`,
      );
      callback(new Error(`Agent failed: ${stderr.slice(0, 200)}`), "");
    } else {
      // Success but empty response
      callback(null, "");
    }
  });

  proc.on("error", (err) => {
    // Process spawn error - might be retryable
    if (attempt <= MAX_RETRIES) {
      console.log(`[googlechat] Spawn error: ${err.message}, retrying...`);
      setTimeout(() => {
        runAgent(message, sessionId, callback, attempt + 1);
      }, RETRY_DELAY_MS);
    } else {
      callback(err, "");
    }
  });
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
  console.log(
    `[googlechat] Mode: Spawn with retry (timeout: ${AGENT_TIMEOUT_MS / 1000}s, retries: ${MAX_RETRIES})`,
  );
});
