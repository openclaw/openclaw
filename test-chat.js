#!/usr/bin/env node
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:19001/");

let nonce = null;

ws.on("open", () => {
  console.log("Connected to gateway");
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.event === "connect.challenge") {
    // Send auth response
    const authResponse = {
      type: "auth",
      method: "token",
      token: "test-token",
      nonce: msg.payload.nonce,
    };
    ws.send(JSON.stringify(authResponse));
    console.log("Sent auth response");
  }

  if (msg.event === "connect.success") {
    console.log("Authenticated successfully!");

    // Send a chat message
    const chatRequest = {
      id: "test-1",
      method: "chat.send",
      params: {
        sessionKey: "test-session",
        message: "Hello! This is a test message.",
        deliver: false,
      },
    };
    ws.send(JSON.stringify(chatRequest));
    console.log("Sent chat message");
  }

  if (msg.method === "chat.send") {
    console.log("Chat response:", JSON.stringify(msg, null, 2));
    if (msg.error) {
      console.log("ERROR:", msg.error);
    } else {
      console.log("SUCCESS! Message sent.");
    }
    ws.close();
    process.exit(0);
  }

  // Handle streaming responses
  if (msg.state === "delta" || msg.state === "final") {
    console.log("Stream:", msg.state, msg.message?.content?.[0]?.text?.substring(0, 100));
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

// Timeout after 30 seconds
setTimeout(() => {
  console.log("Timeout - closing");
  ws.close();
  process.exit(1);
}, 30000);
