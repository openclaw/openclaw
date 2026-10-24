import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { GatewayClient } from "../../../../src/gateway/client.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { createPlaybackMediaFixture } from "../../../fixtures/media-playback.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useChannelProductProof } from "./channel-product-proof.test-support.js";

const SESSION_KEY = "agent:qa:main";
const userEventIdentitySchema = z.object({ messageId: z.string().min(1) });
const FIXTURES = [
  ["artifact.json", "application/json", "attachment", "artifact"],
  ["config.xml", "text/xml", "attachment", "visible-error"],
  ["deploy.yaml", "application/yaml", "attachment", "artifact"],
  ["vector.svg", "image/svg+xml", "attachment", "visible-error"],
  ["worker.py", "text/x-python", "attachment", "visible-error"],
  ["script.js", "text/javascript", "attachment", "visible-error"],
  ["voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3", "audio/mpeg", "audio", "artifact"],
  ["clip.mp4", "video/mp4", "video", "artifact"],
  ["image.png", "image/png", "image", "artifact"],
  ["mystery.blob", "application/octet-stream", "attachment", "visible-error"],
] as const;
const ARTIFACT_FIXTURES = FIXTURES.filter((fixture) => fixture[3] === "artifact");
const REJECTED_FIXTURES = FIXTURES.filter((fixture) => fixture[3] === "visible-error");
const MIXED_BATCH = [
  ["deploy.yaml", "artifact"],
  ["settings.toml", "unsupported-format"],
  ["bundle.7z", "delivery-failed"],
] as const;

const proof = useChannelProductProof();

async function writeFixtures(workspaceDir: string): Promise<void> {
  const files = {
    "artifact.json": '{"status":"ready"}\n',
    "config.xml": '<?xml version="1.0"?><artifact ready="true"/>\n',
    "deploy.yaml": "name: media-artifacts\nready: true\n",
    "vector.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2563eb"/></svg>',
    "worker.py": "def ready():\n    return True\n",
    "script.js": "export const ready = true;\n",
    "settings.toml": 'name = "media-artifacts"\n',
    "voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3": createPlaybackMediaFixture("mp3"),
    "clip.mp4": createPlaybackMediaFixture("mp4"),
    "image.png": createSolidPngBuffer(320, 180, { r: 37, g: 99, b: 235 }),
    "mystery.blob": Buffer.from([0, 1, 2, 3]),
    "bundle.7z": Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
  };
  await Promise.all(
    Object.entries(files).map(([name, body]) => fs.writeFile(path.join(workspaceDir, name), body)),
  );
}

function expectedMediaBlock([name, mimeType, type]: (typeof FIXTURES)[number]) {
  return expect.objectContaining(
    type === "attachment"
      ? { type, attachment: expect.objectContaining({ label: name, mimeType }) }
      : { type, mimeType, [type === "image" ? "alt" : "fileName"]: name },
  );
}

function expectedFailureBlock(label: string, code: string) {
  return expect.objectContaining({
    type: "attachment_error",
    attachment: expect.objectContaining({ label, code }),
  });
}

async function connectWebchat(
  url: string,
  token: string,
  onEvent?: (event: { event: string; payload?: unknown }) => void,
): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    const connecting = new GatewayClient({
      url,
      origin: new URL(url.replace(/^ws/u, "http")).origin,
      token,
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      platform: "qa",
      ...(onEvent ? { onEvent } : {}),
      onHelloOk: () => resolve(connecting),
      onConnectError: reject,
      onClose: (code, reason) => reject(new Error(`Gateway closed ${code}: ${reason}`)),
    });
    connecting.start();
  });
}

async function sendMediaReply(
  gatewayClient: GatewayClient,
  sessionKey: string,
  fixtureNames: readonly string[],
  includeText = true,
): Promise<unknown[]> {
  const runId = randomUUID();
  const mediaDirectives = fixtureNames.map((name) => `MEDIA:./${name}`).join("\n");
  const exactReply = includeText ? `Artifacts ready\n${mediaDirectives}` : mediaDirectives;
  const started = await gatewayClient.request<{ runId?: string }>("chat.send", {
    sessionKey,
    message: `Reply exactly \`${exactReply}\``,
    deliver: false,
    idempotencyKey: runId,
  });
  await gatewayClient.request(
    "agent.wait",
    { runId: started.runId ?? runId, timeoutMs: 120_000 },
    { timeoutMs: 125_000 },
  );
  const history = await gatewayClient.request<{
    messages?: Array<{ role?: string; content?: unknown }>;
  }>("chat.history", { sessionKey, limit: 20 });
  const assistant = history.messages?.findLast((message) => message.role === "assistant");
  return Array.isArray(assistant?.content) ? assistant.content : [];
}

it(
  "WebChat renders each media kind as a named artifact and preserves distinct failure outcomes",
  { timeout: 180_000 },
  async () => {
    const { gateway, transport } = await proof.start({
      controlUiAllowedOrigins: ["http://127.0.0.1"],
    });
    await transport.waitReady({ gateway });
    await writeFixtures(gateway.workspaceDir);
    const events: Array<{ event: string; payload?: unknown }> = [];
    const client = await connectWebchat(gateway.wsUrl, gateway.token, (event) =>
      events.push(event),
    );
    proof.cleanup(() => client.stop());
    await client.request("sessions.subscribe", {});
    const content = await sendMediaReply(
      client,
      SESSION_KEY,
      ARTIFACT_FIXTURES.map((fixture) => fixture[0]),
    );
    expect(content).toEqual(expect.arrayContaining(ARTIFACT_FIXTURES.map(expectedMediaBlock)));
    for (const fixture of REJECTED_FIXTURES) {
      const sessionKey = `agent:qa:rejected-${fixture[0].replace(/[^a-z0-9]+/giu, "-")}`;
      const rejectedContent = await sendMediaReply(client, sessionKey, [fixture[0]], false);
      const serialized = JSON.stringify(rejectedContent);
      expect(rejectedContent, fixture[0]).toEqual(
        expect.arrayContaining([expectedFailureBlock(fixture[0], "unsupported-format")]),
      );
      expect(rejectedContent).not.toEqual(expect.arrayContaining([expectedMediaBlock(fixture)]));
      expect(serialized).not.toContain("MEDIA:./");
      expect(serialized).not.toContain("Media failed");
      const artifactList = await client.request<{ artifacts?: unknown[] }>("artifacts.list", {
        sessionKey,
      });
      expect(artifactList.artifacts ?? [], fixture[0]).toEqual([]);
    }
    const missingContent = await sendMediaReply(
      client,
      "agent:qa:missing-attachment",
      ["missing-proof.yaml"],
      false,
    );
    expect(missingContent).toEqual([expectedFailureBlock("missing-proof.yaml", "file-not-found")]);

    const mixedContent = await sendMediaReply(
      client,
      "agent:qa:mixed-attachment-outcomes",
      MIXED_BATCH.map(([name]) => name),
    );
    expect(mixedContent).toEqual(
      expect.arrayContaining(
        MIXED_BATCH.map(([name, outcome]) =>
          outcome === "artifact"
            ? expect.objectContaining({
                type: "attachment",
                attachment: expect.objectContaining({ label: name }),
              })
            : expectedFailureBlock(name, outcome),
        ),
      ),
    );
    expect(JSON.stringify(mixedContent)).not.toContain("Media failed");
    expect(JSON.stringify(mixedContent)).not.toContain("MEDIA:./");
    const sessionEvents = events.filter(
      ({ event, payload }) =>
        (event === "chat" || event === "session.message") &&
        (payload as { sessionKey?: unknown } | undefined)?.sessionKey === SESSION_KEY,
    );
    const userEvents = sessionEvents.filter(
      (event) =>
        (event.payload as { message?: { role?: string } } | undefined)?.message?.role === "user",
    );
    const userMessageIds = userEvents.map(
      (event) => userEventIdentitySchema.parse(event.payload).messageId,
    );
    expect(userMessageIds.length).toBeGreaterThan(0);
    expect(new Set(userMessageIds).size, JSON.stringify(userMessageIds)).toBe(1);
    const history = await client.request<{ messages?: Array<{ role?: string }> }>("chat.history", {
      sessionKey: SESSION_KEY,
      limit: 20,
    });
    expect(history.messages?.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(userEvents)).toContain("MEDIA:./artifact.json");
    const displayEvents = sessionEvents.filter((event) => !userEvents.includes(event));
    expect(displayEvents).toContainEqual(
      expect.objectContaining({
        event: "session.message",
        payload: expect.objectContaining({
          message: expect.objectContaining({ role: "assistant" }),
        }),
      }),
    );
    expect(JSON.stringify({ content, displayEvents })).not.toContain("MEDIA:./");
  },
);
