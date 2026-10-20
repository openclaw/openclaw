import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { GatewayClient } from "../../../../src/gateway/client.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { createPlaybackMediaFixture } from "../../../fixtures/media-playback.js";
import { createSolidPngBuffer, createTinyJpegBuffer } from "../../../helpers/image-fixtures.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const SESSION_KEY = "agent:qa:main";
const OFFICE_MIME = "application/vnd.openxmlformats-officedocument";
const userEventIdentitySchema = z.object({ messageId: z.string().min(1) });
const FIXTURES = [
  ["artifact.json", "application/json", "attachment", "artifact"],
  ["table.csv", "text/csv", "attachment", "artifact"],
  ["config.xml", "text/xml", "attachment", "visible-error"],
  ["deploy.yaml", "application/yaml", "attachment", "artifact"],
  ["notes.md", "text/markdown", "attachment", "artifact"],
  ["readme.txt", "text/plain", "attachment", "artifact"],
  ["page.html", "text/html", "attachment", "artifact"],
  ["vector.svg", "image/svg+xml", "attachment", "visible-error"],
  ["report.pdf", "application/pdf", "attachment", "artifact"],
  ["bundle.zip", "application/zip", "attachment", "artifact"],
  ["worker.py", "text/x-python", "attachment", "visible-error"],
  ["script.js", "text/javascript", "attachment", "visible-error"],
  ["brief.docx", `${OFFICE_MIME}.wordprocessingml.document`, "attachment", "artifact"],
  ["report.xlsx", `${OFFICE_MIME}.spreadsheetml.sheet`, "attachment", "artifact"],
  ["tone.wav", "audio/wav", "audio", "artifact"],
  ["voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3", "audio/mpeg", "audio", "artifact"],
  ["voice.ogg", "audio/ogg", "audio", "artifact"],
  ["voice.m4a", "audio/x-m4a", "audio", "artifact"],
  ["voice.flac", "audio/flac", "audio", "artifact"],
  ["clip.mp4", "video/mp4", "video", "artifact"],
  ["clip.webm", "video/webm", "video", "artifact"],
  ["image.png", "image/png", "image", "artifact"],
  ["photo.jpg", "image/jpeg", "image", "artifact"],
  ["mystery.blob", "application/octet-stream", "attachment", "visible-error"],
] as const;
const ARTIFACT_FIXTURES = FIXTURES.filter((fixture) => fixture[3] === "artifact");
const REJECTED_FIXTURES = FIXTURES.filter((fixture) => fixture[3] === "visible-error");
const MIXED_BATCH = [
  ["deploy.yaml", "artifact"],
  ["settings.toml", "unsupported-format"],
  ["schema.sql", "unsupported-format"],
  ["events.ndjson", "unsupported-format"],
  ["font.ttf", "unsupported-format"],
  ["font.woff2", "unsupported-format"],
  ["bundle.7z", "delivery-failed"],
] as const;

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
let client: GatewayClient | undefined;

afterEach(async () => {
  try {
    await runQaGatewayFixture(
      async () => client?.stop(),
      () => gatewayOwner && stopQaGatewayFixture(gatewayOwner),
      () => bus?.stop(),
    );
  } finally {
    client = undefined;
    gatewayOwner = undefined;
    bus = undefined;
  }
});

async function writeFixtures(workspaceDir: string): Promise<void> {
  const archive = new JSZip();
  archive.file("README.txt", "OpenClaw artifact proof\n");
  const files = {
    "artifact.json": '{"status":"ready"}\n',
    "table.csv": "name,status\nrabbit,ready\n",
    "config.xml": '<?xml version="1.0"?><artifact ready="true"/>\n',
    "deploy.yaml": "name: media-artifacts\nready: true\n",
    "notes.md": "# Artifact proof\n\nManaged Markdown document.\n",
    "readme.txt": "Managed plain text document.\n",
    "page.html": "<!doctype html><title>Artifact proof</title><h1>Ready</h1>\n",
    "vector.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2563eb"/></svg>',
    "report.pdf": "%PDF-1.4\n% OpenClaw artifact proof\n",
    "worker.py": "def ready():\n    return True\n",
    "script.js": "export const ready = true;\n",
    "settings.toml": 'name = "media-artifacts"\n',
    "schema.sql": "select 1;\n",
    "events.ndjson": '{"ready":true}\n',
    "bundle.zip": await archive.generateAsync({ type: "nodebuffer" }),
    "brief.docx": await officeZip("docx"),
    "report.xlsx": await officeZip("xlsx"),
    "tone.wav": createWavBuffer(),
    "voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3": createPlaybackMediaFixture("mp3"),
    "voice.ogg": createPlaybackMediaFixture("ogg"),
    "voice.m4a": createPlaybackMediaFixture("m4a"),
    "voice.flac": createPlaybackMediaFixture("flac"),
    "clip.webm": createPlaybackMediaFixture("webm"),
    "clip.mp4": createPlaybackMediaFixture("mp4"),
    "image.png": createSolidPngBuffer(320, 180, { r: 37, g: 99, b: 235 }),
    "photo.jpg": createTinyJpegBuffer(),
    "mystery.blob": Buffer.from([0, 1, 2, 3]),
    "font.ttf": Buffer.from([0x00, 0x01, 0x00, 0x00]),
    "font.woff2": Buffer.from("wOF2", "ascii"),
    "bundle.7z": Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
  };
  await Promise.all(
    Object.entries(files).map(([name, body]) => fs.writeFile(path.join(workspaceDir, name), body)),
  );
}

async function officeZip(kind: "docx" | "xlsx"): Promise<Buffer> {
  const zip = new JSZip();
  const root = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
  const mime =
    kind === "docx"
      ? `${OFFICE_MIME}.wordprocessingml.document.main+xml`
      : `${OFFICE_MIME}.spreadsheetml.sheet.main+xml`;
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${root}" ContentType="${mime}"/></Types>`,
  );
  zip.file(root, "<document/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

function createWavBuffer(): Buffer {
  const samples = 8_000;
  const body = Buffer.alloc(44 + samples * 2);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(body.length - 8, 4);
  body.write("WAVEfmt ", 8, "ascii");
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8_000, 24);
  body.writeUInt32LE(16_000, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write("data", 36, "ascii");
  body.writeUInt32LE(samples * 2, 40);
  return body;
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
  "WebChat managed media artifact matrix renders every MEDIA reference as one named success or failure outcome",
  { timeout: 180_000 },
  async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    bus = await startQaBusServer({ state });
    gatewayOwner = createQaLiveLaneGateway();
    const harness = await gatewayOwner.start({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiAllowedOrigins: ["http://127.0.0.1"],
      controlUiEnabled: false,
    });
    await transport.waitReady({ gateway: harness.gateway });
    await writeFixtures(harness.gateway.workspaceDir);
    const events: Array<{ event: string; payload?: unknown }> = [];
    client = await connectWebchat(harness.gateway.wsUrl, harness.gateway.token, (event) =>
      events.push(event),
    );
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
