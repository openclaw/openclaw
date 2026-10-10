import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../infra/kysely-sync.js";

type ReceiptDatabase = {
  assistant_text_receipts: { external_key: string; text_sha256: string };
  imports: { id: number; payload: string | null };
};

/** Uses only the owning history index's reconstructible database. */
export function createCliAssistantTextReceipts(database: DatabaseSync) {
  const db = getNodeSqliteKysely<ReceiptDatabase>(database);
  const insert = prepareSqliteQuerySync<{ externalKey: string; textSha256: string }>(
    database,
    (parameter) =>
      db
        .insertInto("assistant_text_receipts")
        .values({
          external_key: parameter((row) => row.externalKey),
          text_sha256: parameter((row) => row.textSha256),
        })
        .onConflict((conflict) => conflict.column("external_key").doNothing()),
  );
  const read = prepareSqliteQueryTakeFirstSync<string, { text_sha256: string }>(
    database,
    (parameter) =>
      db
        .selectFrom("assistant_text_receipts")
        .select("text_sha256")
        .where(
          "external_key",
          "=",
          parameter((key) => key),
        ),
  );
  const readImport = prepareSqliteQueryTakeFirstSync<number, { payload: string | null }>(
    database,
    (parameter) =>
      db
        .selectFrom("imports")
        .select("payload")
        .where(
          "id",
          "=",
          parameter((id) => id),
        ),
  );
  const replaceImport = prepareSqliteQuerySync<{ id: number; payload: string }>(
    database,
    (parameter) =>
      db
        .updateTable("imports")
        .set({ payload: parameter((row) => row.payload) })
        .where(
          "id",
          "=",
          parameter((row) => row.id),
        ),
  );
  return {
    capture(message: unknown): boolean {
      const record = asOptionalRecord(message);
      const receipt = asOptionalRecord(
        asOptionalRecord(record?.["__openclaw"])?.cliAssistantTextReceipt,
      );
      const provider = normalizeOptionalString(receipt?.provider);
      const cliSessionId = normalizeOptionalString(receipt?.cliSessionId);
      if (
        record?.role !== "assistant" ||
        provider !== "claude-cli" ||
        !cliSessionId ||
        !Array.isArray(receipt?.messages)
      ) {
        return false;
      }
      let admitted = false;
      for (const entry of receipt.messages) {
        const identity = asOptionalRecord(entry);
        const externalId = normalizeOptionalString(identity?.externalId);
        const textSha256 = normalizeOptionalString(identity?.textSha256);
        if (externalId && textSha256 && /^[a-f0-9]{64}$/.test(textSha256)) {
          insert({ externalKey: JSON.stringify([externalId, provider, cliSessionId]), textSha256 });
          admitted = true;
        }
      }
      return admitted;
    },
    project(imported: {
      role: string | null;
      external_key: string | null;
      source_text_sha256: string | null;
      id: number;
    }): { omitted: true } | { message: Record<string, unknown> } | undefined {
      const receipt =
        imported.role === "assistant" && imported.external_key
          ? read(imported.external_key)
          : undefined;
      if (!receipt || imported.source_text_sha256 !== receipt.text_sha256) {
        return undefined;
      }
      const payload = readImport(imported.id)?.payload;
      const record = payload ? asOptionalRecord(JSON.parse(payload)) : undefined;
      if (!record) {
        return undefined;
      }
      // The receipt covers text only. Preserve tool calls, thoughts, signatures,
      // and provenance from mixed assistant rows without touching canonical bytes.
      const content = Array.isArray(record.content)
        ? record.content.filter((block) => asOptionalRecord(block)?.type !== "text")
        : [];
      if (!content.length) {
        return { omitted: true };
      }
      const message: Record<string, unknown> = { ...record, content };
      delete message.text;
      replaceImport({ id: imported.id, payload: JSON.stringify(message) });
      return { message };
    },
  };
}
