import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { withTempHome } from "../../../test/helpers/temp-home.js";

describe("fs.write", () => {
  it("writes base64-decoded bytes within the workspace and creates parent dirs", async () => {
    await withTempHome(
      async () => {
        vi.resetModules();

        const [{ fsHandlers }, { DEFAULT_AGENT_WORKSPACE_DIR }] = await Promise.all([
          import("./fs.js"),
          import("../../agents/workspace.js"),
        ]);

        let captured:
          | { ok: true; payload: unknown }
          | { ok: false; error: { code?: string; message?: string } | undefined }
          | null = null;
        const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
          captured = ok
            ? { ok: true, payload }
            : {
                ok: false,
                error:
                  error && typeof error === "object"
                    ? (error as { code?: string; message?: string })
                    : undefined,
              };
        };

        await fsHandlers["fs.write"]({
          req: { type: "req", id: "t1", method: "fs.write", params: {} } as unknown as never,
          params: {
            path: "media/inbound/test.txt",
            content: "SGVsbG8gV29ybGQ=",
          },
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: {} as unknown as GatewayRequestContext,
        });

        expect(captured).not.toBeNull();
        expect(captured && captured.ok).toBe(true);

        const outPath = path.join(DEFAULT_AGENT_WORKSPACE_DIR, "media", "inbound", "test.txt");
        await expect(fs.stat(outPath)).resolves.toBeTruthy();
        await expect(fs.readFile(outPath, "utf-8")).resolves.toBe("Hello World");
      },
      { env: { OPENCLAW_PROFILE: "fs-write-test" } },
    );
  });

  it("rejects path traversal attempts", async () => {
    await withTempHome(
      async () => {
        vi.resetModules();
        const { fsHandlers } = await import("./fs.js");

        let captured: { ok: boolean; error?: { message?: string } } | null = null;
        const respond = (ok: boolean, _payload?: unknown, error?: unknown) => {
          captured = {
            ok,
            error: error && typeof error === "object" ? (error as { message?: string }) : undefined,
          };
        };

        await fsHandlers["fs.write"]({
          req: { type: "req", id: "t2", method: "fs.write", params: {} } as unknown as never,
          params: {
            path: "../../etc/passwd",
            content: "SGVsbG8=",
          },
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: {} as unknown as GatewayRequestContext,
        });

        expect(captured).not.toBeNull();
        expect(captured?.ok).toBe(false);
        expect(captured?.error?.message ?? "").toContain("within workspace");
      },
      { env: { OPENCLAW_PROFILE: "fs-write-test" } },
    );
  });

  it("rejects invalid base64", async () => {
    await withTempHome(
      async () => {
        vi.resetModules();
        const { fsHandlers } = await import("./fs.js");

        let captured: { ok: boolean; error?: { message?: string } } | null = null;
        const respond = (ok: boolean, _payload?: unknown, error?: unknown) => {
          captured = {
            ok,
            error: error && typeof error === "object" ? (error as { message?: string }) : undefined,
          };
        };

        await fsHandlers["fs.write"]({
          req: { type: "req", id: "t3", method: "fs.write", params: {} } as unknown as never,
          params: {
            path: "media/inbound/bad.bin",
            content: "not base64!!!",
          },
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: {} as unknown as GatewayRequestContext,
        });

        expect(captured).not.toBeNull();
        expect(captured?.ok).toBe(false);
        expect(captured?.error?.message ?? "").toContain("base64");
      },
      { env: { OPENCLAW_PROFILE: "fs-write-test" } },
    );
  });
});
