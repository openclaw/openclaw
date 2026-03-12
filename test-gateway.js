#!/usr/bin/env node
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:19001/");

let nonce = null;
const token = process.env.OPENCLAW_GATEWAY_TOKEN || "test-token-placeholder";

console.log("Connecting to gateway at ws://127.0.0.1:19001/");

ws.on("open", () => {
  console.log("✓ Connected to gateway");
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  console.log("Received:", JSON.stringify(msg, null, 2));

  if (msg.event === "connect.challenge") {
    console.log("Received challenge, sending auth response...");
    const authResponse = {
      type: "auth",
      method: "token",
      token: token,
      nonce: msg.payload.nonce,
    };
    ws.send(JSON.stringify(authResponse));
    console.log("✓ Sent auth response");
  }

  if (msg.event === "connect.success") {
    console.log("✓ Authenticated successfully!");

    // Send a chat message using agent method
    const chatRequest = {
      id: "test-1",
      method: "agent",
      params: {
        message: "Hello! This is a test message from the gateway test.",
        sessionKey: "main",
      },
    };
    ws.send(JSON.stringify(chatRequest));
    console.log("✓ Sent chat message to agent");
  }

  if (msg.method === "agent" || msg.id === "test-1") {
    console.log("\n=== Chat Response ===");
    console.log(JSON.stringify(msg, null, 2));

    if (msg.error) {
      console.log("ERROR:", msg.error);
    } else {
      console.log("SUCCESS! Message sent.");
    }
  }

  // Handle streaming responses
  if (msg.state === "delta" || msg.state === "final") {
    console.log("\nStream:", msg.state, msg.message?.content?.[0]?.text?.substring(0, 200));
  }

  if (msg.event === "agent.stop") {
    console.log("\n=== Agent finished ===");
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

ws.on("close", () => {
  console.log("Connection closed");
  process.exit(0);
});

// Timeout after 60 seconds
setTimeout(() => {
  console.log("Timeout - closing");
  ws.close();
  process.exit(0);
}, 60000);
