import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function writeArchivedTranscript(params: {
  dir: string;
  sessionId: string;
  reason: "reset" | "deleted";
  archivedAt: string;
  lines: string[];
}): Promise<string> {
  const archiveSuffix = params.archivedAt.replaceAll(":", "-");
  const fileName = `${params.sessionId}.jsonl.${params.reason}.${archiveSuffix}`;
  const fullPath = path.join(params.dir, fileName);
  await fs.writeFile(fullPath, `${params.lines.join("\n")}\n`, "utf-8");
  return fileName;
}

test("sessions.archived.list returns archived transcripts in the agent sessions dir", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("11111111-1111-4111-8111-111111111111"),
    },
  });

  const archivedReset = await writeArchivedTranscript({
    dir,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    reason: "reset",
    archivedAt: "2026-05-05T09:57:18.833Z",
    lines: [
      JSON.stringify({ type: "session", version: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      JSON.stringify({ message: { role: "user", content: "hello" } }),
    ],
  });

  const archivedDeleted = await writeArchivedTranscript({
    dir,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    reason: "deleted",
    archivedAt: "2026-05-04T08:30:11.000Z",
    lines: [
      JSON.stringify({ type: "session", version: 1, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    ],
  });

  const { ws } = await openClient();
  const listed = await rpcReq<{
    archived: Array<{
      archivedFileName: string;
      reason: "reset" | "deleted";
      sessionId: string;
      sizeBytes: number;
      agentId: string;
      archivedAt: number;
    }>;
  }>(ws, "sessions.archived.list", {});

  expect(listed.ok).toBe(true);
  const fileNames = listed.payload?.archived.map((entry) => entry.archivedFileName) ?? [];
  expect(fileNames).toContain(archivedReset);
  expect(fileNames).toContain(archivedDeleted);

  const archivedRow = listed.payload?.archived.find(
    (entry) => entry.archivedFileName === archivedReset,
  );
  expect(archivedRow?.reason).toBe("reset");
  expect(archivedRow?.sessionId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(archivedRow?.sizeBytes).toBeGreaterThan(0);
  expect(archivedRow?.agentId).toBe("main");
});

test("sessions.archived.read returns messages from a specific archived transcript", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("33333333-3333-4333-8333-333333333333"),
    },
  });

  const archivedFileName = await writeArchivedTranscript({
    dir,
    sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    reason: "reset",
    archivedAt: "2026-05-05T10:01:00.000Z",
    lines: [
      JSON.stringify({ type: "session", version: 1, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      JSON.stringify({
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAA==" },
            },
          ],
        },
      }),
      JSON.stringify({ message: { role: "assistant", content: "ok" } }),
    ],
  });

  const { ws } = await openClient();
  const read = await rpcReq<{
    archivedFileName: string;
    sessionId: string;
    reason: "reset" | "deleted";
    archivedAt: number;
    agentId: string;
    messages: unknown[];
    totalMessages: number;
  }>(ws, "sessions.archived.read", { archivedFileName });

  expect(read.ok).toBe(true);
  expect(read.payload?.archivedFileName).toBe(archivedFileName);
  expect(read.payload?.sessionId).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  expect(read.payload?.reason).toBe("reset");
  expect(read.payload?.agentId).toBe("main");
  expect(Array.isArray(read.payload?.messages)).toBe(true);
  expect(read.payload?.totalMessages).toBeGreaterThanOrEqual(2);

  const allText = JSON.stringify(read.payload?.messages ?? []);
  expect(allText).toContain("describe this image");
  // The base64 image payload is preserved end-to-end.
  expect(allText).toContain("iVBORw0KGgoAAA==");
});

test("sessions.archived.read rejects path traversal and missing archives", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("99999999-9999-4999-8999-999999999999"),
    },
  });

  const { ws } = await openClient();
  const traversal = await rpcReq(ws, "sessions.archived.read", {
    archivedFileName: "../../escape.jsonl.reset.2026-05-05T09-57-18.833Z",
  });
  expect(traversal.ok).toBe(false);

  const missing = await rpcReq(ws, "sessions.archived.read", {
    archivedFileName: "00000000-0000-4000-8000-000000000000.jsonl.reset.2026-05-05T09-57-18.833Z",
  });
  expect(missing.ok).toBe(false);
});
