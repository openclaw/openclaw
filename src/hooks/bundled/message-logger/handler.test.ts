import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

const contactManagerMocks = vi.hoisted(() => ({
  findByPhone: vi.fn(),
}));

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: configMocks.loadConfig,
  };
});

vi.mock("../../../contacts/contact-manager.js", () => ({
  getContactManager: () => ({
    findByPhone: contactManagerMocks.findByPhone,
  }),
}));

import {
  messageLoggerReceivedHandler,
  messageLoggerSentHandler,
  messageLoggerTranscribedHandler,
} from "./handler.js";

const hookContext = { channelId: "whatsapp" };

function buildConfig(workspaceDir: string) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    hooks: {
      internal: {
        entries: {
          "message-logger": {
            enabled: true,
          },
        },
      },
    },
  };
}

async function writeContactsMap(
  workspaceDir: string,
  entries: Record<string, string | { name: string; slug: string }>,
) {
  const mapPath = path.join(workspaceDir, "memory", "system", "contacts-map.json");
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.writeFile(mapPath, JSON.stringify(entries, null, 2), "utf-8");
}

async function readHistoryFile(workspaceDir: string, slug: string, date: Date): Promise<string> {
  const filePath = path.join(
    workspaceDir,
    "chat-history",
    slug,
    `${date.toISOString().split("T")[0]}.md`,
  );
  return fs.readFile(filePath, "utf-8");
}

describe("message-logger", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    configMocks.loadConfig.mockReset();
    contactManagerMocks.findByPhone.mockReset();
    contactManagerMocks.findByPhone.mockReturnValue(undefined);
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("uses contacts-map slugs before senderName for inbound direct messages", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-message-logger-"));
    tempDirs.push(workspaceDir);
    const date = new Date("2026-03-10T14:15:00Z");

    await writeContactsMap(workspaceDir, {
      "15550001111": {
        name: "Paola Financeiro",
        slug: "paola-assami-financeiro",
      },
    });
    configMocks.loadConfig.mockReturnValue(buildConfig(workspaceDir));

    await messageLoggerReceivedHandler(
      {
        from: "15550001111@s.whatsapp.net",
        content: "Oi, segue a atualizacao.",
        timestamp: Math.floor(date.getTime() / 1000),
        metadata: {
          senderE164: "+15550001111",
          senderName: "Nome Mutavel",
        },
      },
      hookContext,
    );

    const content = await readHistoryFile(workspaceDir, "paola-assami-financeiro", date);
    expect(content).toContain("# Chat: Paola Financeiro");
    expect(content).toContain("Oi, segue a atualizacao.");
    expect(content).not.toContain("Nome Mutavel");
  });

  it("writes group messages with canonical sender labels and group slugs from contacts-map", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-message-logger-"));
    tempDirs.push(workspaceDir);
    const date = new Date("2026-03-10T15:45:00Z");

    await writeContactsMap(workspaceDir, {
      "15550002222": {
        name: "Alice Canonical",
        slug: "alice-canonical",
      },
      "120363424771379436@g.us": {
        name: "Family Group",
        slug: "family-group",
      },
    });
    configMocks.loadConfig.mockReturnValue(buildConfig(workspaceDir));

    await messageLoggerReceivedHandler(
      {
        from: "120363424771379436@g.us",
        content: "Mensagem de grupo",
        timestamp: Math.floor(date.getTime() / 1000),
        metadata: {
          chatType: "group",
          groupSubject: "Family Group",
          senderE164: "+15550002222",
          senderName: "Alice WhatsApp",
        },
      },
      hookContext,
    );

    const content = await readHistoryFile(workspaceDir, "family-group", date);
    expect(content).toContain("# Chat: Family Group");
    expect(content).toContain("**Alice Canonical**: Mensagem de grupo");
    expect(content).not.toContain("Alice WhatsApp");
  });

  it("replaces audio placeholders in place when message_transcribed arrives later", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-message-logger-"));
    tempDirs.push(workspaceDir);
    const date = new Date("2026-03-10T16:20:00Z");

    await writeContactsMap(workspaceDir, {
      "15550003333": {
        name: "Caio Audio",
        slug: "caio-audio",
      },
    });
    configMocks.loadConfig.mockReturnValue(buildConfig(workspaceDir));

    await messageLoggerReceivedHandler(
      {
        from: "15550003333@s.whatsapp.net",
        content: "<media:audio>",
        timestamp: Math.floor(date.getTime() / 1000),
        metadata: {
          senderE164: "+15550003333",
          mediaTypes: ["audio/ogg"],
        },
      },
      hookContext,
    );

    await messageLoggerTranscribedHandler(
      {
        from: "15550003333@s.whatsapp.net",
        transcript: "linha 1\nlinha 2",
        timestamp: Math.floor(date.getTime() / 1000),
        metadata: {
          senderE164: "+15550003333",
        },
      },
      hookContext,
    );

    const content = await readHistoryFile(workspaceDir, "caio-audio", date);
    expect(content).toContain("[audio]");
    expect(content).toContain("> linha 1");
    expect(content).toContain("> linha 2");
    expect(content).not.toContain("[audio sem transcricao]");
  });

  it("appends outbound messages with media references to the same history file", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-message-logger-"));
    tempDirs.push(workspaceDir);
    const date = new Date("2026-03-10T17:05:00Z");

    await writeContactsMap(workspaceDir, {
      "15550004444": {
        name: "Bruna Docs",
        slug: "bruna-docs",
      },
    });
    configMocks.loadConfig.mockReturnValue(buildConfig(workspaceDir));
    vi.useFakeTimers();
    vi.setSystemTime(date);

    await messageLoggerSentHandler(
      {
        to: "+15550004444",
        content: "Segue o anexo",
        success: true,
        metadata: {
          mediaUrls: ["https://files.example.com/docs/fatura.pdf"],
        },
      },
      hookContext,
    );

    const content = await readHistoryFile(workspaceDir, "bruna-docs", date);
    expect(content).toContain("# Chat: Bruna Docs");
    expect(content).toContain("Segue o anexo");
    expect(content).toContain("fatura.pdf");
  });
});
