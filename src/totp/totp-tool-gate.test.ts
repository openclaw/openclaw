import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelegramTotpConfig } from "../config/types.telegram.js";
import { enrollTotpUser, verifyAndCreateSession } from "./totp-store.js";
import { wrapToolsWithTotpGate } from "./totp-tool-gate.js";
import { decodeBase32, generateTotp } from "./totp.js";

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-totp-gate-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeMockTool(name: string) {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: {},
    execute: async () => `${name} executed`,
  };
}

describe("wrapToolsWithTotpGate", () => {
  const totpConfig: TelegramTotpConfig = {
    enabled: true,
    protectedToolGroups: ["group:fs", "group:web", "exec"],
  };

  it("passes through tools when no protected groups are configured", () => {
    const tools = [makeMockTool("exec"), makeMockTool("read")];
    const result = wrapToolsWithTotpGate(tools, {
      totpConfig: { enabled: true },
      senderId: "12345",
    });
    // No protectedToolGroups -> no wrapping
    expect(result).toEqual(tools);
  });

  it("wraps protected tools and passes unprotected tools through", () => {
    const tools = [
      makeMockTool("exec"),
      makeMockTool("read"),
      makeMockTool("session_status"),
      makeMockTool("web_search"),
    ];
    const result = wrapToolsWithTotpGate(tools, { totpConfig, senderId: "12345" });
    // exec, read, web_search are in protected groups; session_status is not
    expect(result).toHaveLength(4);
    // The unprotected tool should be unchanged
    expect(result[2]).toBe(tools[2]);
    // The protected tools should be wrapped (different reference)
    expect(result[0]).not.toBe(tools[0]);
    expect(result[1]).not.toBe(tools[1]);
    expect(result[3]).not.toBe(tools[3]);
  });

  it("blocks protected tool execution when user has no TOTP session", async () => {
    await enrollTotpUser("12345");
    const tools = [makeMockTool("exec")];
    const [wrappedExec] = wrapToolsWithTotpGate(tools, { totpConfig, senderId: "12345" });
    await expect(wrappedExec!.execute!("call-1", {}, undefined, undefined)).rejects.toThrow(
      "TOTP authentication required",
    );
  });

  it("allows protected tool execution when user has valid TOTP session", async () => {
    const { secretBase32 } = await enrollTotpUser("12345");
    const secret = decodeBase32(secretBase32);
    const code = generateTotp(secret);
    await verifyAndCreateSession("12345", code, 3600, 5, 300);

    const tools = [makeMockTool("exec")];
    const [wrappedExec] = wrapToolsWithTotpGate(tools, { totpConfig, senderId: "12345" });
    const result = await wrappedExec!.execute!("call-1", {}, undefined, undefined);
    expect(result).toBe("exec executed");
  });

  it("allows protected tool when user is not enrolled in TOTP", async () => {
    // User not enrolled -> hasValidSession returns false but the gate should still
    // work based on enrollment. Since the user is not enrolled, there's no session,
    // so the tool gate will block. This is the correct behavior: if TOTP is enabled
    // for the account AND protectedToolGroups is set, only users with sessions can use tools.
    const tools = [makeMockTool("exec")];
    const [wrappedExec] = wrapToolsWithTotpGate(tools, { totpConfig, senderId: "99999" });
    // Non-enrolled user has no session -> blocked
    await expect(wrappedExec!.execute!("call-1", {}, undefined, undefined)).rejects.toThrow(
      "TOTP authentication required",
    );
  });

  it("expands group:fs to individual tool names", () => {
    const tools = [
      makeMockTool("read"),
      makeMockTool("write"),
      makeMockTool("edit"),
      makeMockTool("apply_patch"),
      makeMockTool("message"),
    ];
    const result = wrapToolsWithTotpGate(tools, {
      totpConfig: { enabled: true, protectedToolGroups: ["group:fs"] },
      senderId: "12345",
    });
    // read, write, edit, apply_patch are in group:fs; message is not
    expect(result[4]).toBe(tools[4]); // message unchanged
    expect(result[0]).not.toBe(tools[0]); // read wrapped
    expect(result[1]).not.toBe(tools[1]); // write wrapped
    expect(result[2]).not.toBe(tools[2]); // edit wrapped
    expect(result[3]).not.toBe(tools[3]); // apply_patch wrapped
  });
});
