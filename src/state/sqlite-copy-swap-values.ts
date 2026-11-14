// Value casts for the copy-and-swap upgrade.
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

function affinity(type: string): "INTEGER" | "REAL" | "TEXT" | "BLOB" | "ANY" {
  if (type === "ANY" || type === "") {
    return "ANY";
  }
  if (type.includes("INT")) {
    return "INTEGER";
  }
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
    return "TEXT";
  }
  if (type.includes("BLOB")) {
    return "BLOB";
  }
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
    return "REAL";
  }
  return "ANY";
}

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/u;

/** Cast one stored value to the column's declared type, or report that it cannot be. */
export function castValue(
  value: SQLOutputValue,
  type: string,
):
  | { ok: true; value: SQLInputValue }
  | {
      ok: false;
    } {
  if (value === null) {
    return { ok: true, value: null };
  }
  switch (affinity(type)) {
    case "ANY":
      return { ok: true, value };
    case "TEXT":
      if (typeof value === "string") {
        return { ok: true, value };
      }
      if (value instanceof Uint8Array) {
        // Invalid bytes become U+FFFD; the row is still copied.
        return { ok: true, value: utf8.decode(value) };
      }
      return { ok: true, value: String(value) };
    case "INTEGER": {
      if (typeof value === "bigint") {
        return { ok: true, value };
      }
      if (typeof value === "number") {
        return Number.isInteger(value) ? { ok: true, value: BigInt(value) } : { ok: false };
      }
      const text = typeof value === "string" ? value : utf8.decode(value);
      return INTEGER_TEXT.test(text) ? { ok: true, value: BigInt(text.trim()) } : { ok: false };
    }
    case "REAL": {
      if (typeof value === "number") {
        return { ok: true, value };
      }
      if (typeof value === "bigint") {
        return { ok: true, value: Number(value) };
      }
      const text = typeof value === "string" ? value : utf8.decode(value);
      const number = text.trim() === "" ? Number.NaN : Number(text);
      return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
    }
    case "BLOB":
      if (value instanceof Uint8Array) {
        return { ok: true, value };
      }
      return { ok: true, value: Buffer.from(String(value), "utf8") };
    default:
      return { ok: false };
  }
}

export function jsonRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Uint8Array
        ? { base64: Buffer.from(value).toString("base64") }
        : typeof value === "bigint"
          ? value.toString()
          : value;
  }
  return out;
}
