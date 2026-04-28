import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import {
  MemorySearchDebugParamsSchema,
  MemorySourceOpenParamsSchema,
  MemoryStatusParamsSchema,
} from "./memory.js";
import { ProtocolSchemas } from "./protocol-schemas.js";
import type {
  MemorySearchDebugParams,
  MemorySourceOpenParams,
  MemoryStatusParams,
} from "./types.js";

const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;

function compile(schema: object) {
  return new Ajv({ allErrors: true, strict: false, removeAdditional: false }).compile(schema);
}

describe("memory protocol schemas", () => {
  it("registers memory params and result schemas in ProtocolSchemas", () => {
    expect(ProtocolSchemas.MemoryStatusParams).toBe(MemoryStatusParamsSchema);
    expect(ProtocolSchemas.MemorySearchDebugParams).toBe(MemorySearchDebugParamsSchema);
    expect(ProtocolSchemas.MemorySourceOpenParams).toBe(MemorySourceOpenParamsSchema);
    expect(ProtocolSchemas.MemoryStatusResult).toBeTruthy();
    expect(ProtocolSchemas.MemorySourcesListResult).toBeTruthy();
    expect(ProtocolSchemas.MemorySearchDebugResult).toBeTruthy();
    expect(ProtocolSchemas.MemoryIndexRunResult).toBeTruthy();
    expect(ProtocolSchemas.MemoryIndexJobsResult).toBeTruthy();
    expect(ProtocolSchemas.MemorySourceOpenResult).toBeTruthy();
  });

  it("does not expose agent override fields on params types", () => {
    type Forbidden = "agentId" | "agent_id" | "allAgents" | "bypassScope" | "path" | "absolutePath";
    type HasForbidden<T> = Extract<keyof T, Forbidden> extends never ? false : true;
    const statusHasForbidden: HasForbidden<MemoryStatusParams> = false;
    const searchHasForbidden: HasForbidden<MemorySearchDebugParams> = false;
    const openHasForbidden: HasForbidden<MemorySourceOpenParams> = false;

    expect(statusHasForbidden).toBe(false);
    expect(searchHasForbidden).toBe(false);
    expect(openHasForbidden).toBe(false);
  });

  it("rejects forbidden memory params at schema level", () => {
    const validateSearch = compile(MemorySearchDebugParamsSchema);
    expect(validateSearch({ sessionKey: "s", query: "q", agentId: "chief" })).toBe(false);
    expect(validateSearch({ sessionKey: "s", query: "q", allAgents: true })).toBe(false);
    expect(validateSearch({ sessionKey: "s", query: "q", bypassScope: true })).toBe(false);
    expect(validateSearch({ sessionKey: "s", query: "q", absolutePath: "/tmp/x" })).toBe(false);
  });

  it("source.open accepts sourceRef and rejects path based open", () => {
    const validateOpen = compile(MemorySourceOpenParamsSchema);
    expect(validateOpen({ sessionKey: "s", sourceRef: "memsrc_123", from: 1, lines: 20 })).toBe(
      true,
    );
    expect(validateOpen({ sessionKey: "s", sourceRef: "memsrc_123", path: "memory/a.md" })).toBe(
      false,
    );
    expect(validateOpen({ sessionKey: "s", path: "memory/a.md" })).toBe(false);
  });
});
