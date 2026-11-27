// Same fetch/SSE boundary used by the native-translation isolation proof.
// The real SDK serializes requests; no real credential or network is available.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const rejectNetwork = () => {
  throw new Error("Unexpected network connection in locale proof");
};
net.connect = net.createConnection = net.Socket.prototype.connect = rejectNetwork;
syncBuiltinESMExports();

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
  const payload = await request.json();
  const message = payload.input.findLast((item) => item.role === "user");
  const prompt =
    typeof message.content === "string"
      ? message.content
      : message.content.map((item) => item.text ?? "").join("");
  const start = prompt.indexOf("\n{");
  assert.ok(start >= 0, "serialized provider request must contain the translation batch");
  const batch = JSON.parse(prompt.slice(start + 1));
  const phase = process.env.LOCALE_PROOF_PHASE;
  assert.ok(phase && process.env.LOCALE_PROOF_REQUESTS);
  fs.appendFileSync(
    process.env.LOCALE_PROOF_REQUESTS,
    JSON.stringify({
      ids: Object.keys(batch),
      proof: Object.fromEntries(
        Object.entries(batch).filter(([key]) => key.startsWith("localeWorkflowProof.")),
      ),
    }) + "\n",
  );
  const translated = Object.fromEntries(
    Object.entries(batch).map(([key, text]) => {
      assert.equal(typeof text, "string");
      return [key, phase + "::" + text];
    }),
  );
  const item = { id: "message", type: "message", role: "assistant", content: [] };
  const text = JSON.stringify(translated);
  const events = [
    { type: "response.created", response: { id: "response" } },
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, content: [{ type: "output_text", text, annotations: [] }] },
    },
    { type: "response.completed", response: { id: "response", status: "completed" } },
  ];
  return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
};
