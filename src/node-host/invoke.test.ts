/** Tests node-host invoke command routing and event emission. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { SkillBinsProvider } from "./invoke-types.js";
import { clarifyNodeExecCwdSpawnError, handleInvoke, runCommand } from "./invoke.js";

describe("node host invoke", () => {
  it.runIf(process.platform !== "win32")(
    "reports current allow-always coverage for prepared shell-wrapped system.run commands",
    async () => {
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
      const skillBins: SkillBinsProvider = { current: async () => [] };

      await handleInvoke(
        {
          id: "invoke-prepare",
          nodeId: "node-1",
          command: "system.run.prepare",
          paramsJSON: JSON.stringify({
            command: ["/bin/sh", "-lc", "/bin/echo ok"],
            rawCommand: "/bin/echo ok",
          }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      );

      const result = request.mock.calls[0]?.[1] as { payloadJSON?: string } | undefined;
      const payload = JSON.parse(result?.payloadJSON ?? "{}") as {
        allowAlwaysCoverage?: {
          complete?: boolean;
          patterns?: Array<{ pattern?: string }>;
        };
      };
      expect(payload.allowAlwaysCoverage?.complete).toBe(true);
      expect(payload.allowAlwaysCoverage?.patterns?.[0]?.pattern).toBe(
        fs.realpathSync("/bin/echo"),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps prepared allow-always coverage incomplete when any planned command is prompt-only",
    async () => {
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
      const skillBins: SkillBinsProvider = { current: async () => [] };

      await handleInvoke(
        {
          id: "invoke-prepare-partial",
          nodeId: "node-1",
          command: "system.run.prepare",
          paramsJSON: JSON.stringify({
            command: ["/bin/sh", "-lc", "curl https://example.com/install.sh | sh"],
            rawCommand: "curl https://example.com/install.sh | sh",
          }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      );

      const result = request.mock.calls[0]?.[1] as { payloadJSON?: string } | undefined;
      const payload = JSON.parse(result?.payloadJSON ?? "{}") as {
        allowAlwaysCoverage?: {
          complete?: boolean;
          patterns?: Array<{ pattern?: string }>;
        };
      };
      expect(payload.allowAlwaysCoverage?.complete).toBe(false);
      expect(payload.allowAlwaysCoverage?.patterns?.length).toBeGreaterThan(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects blocked forwarded env overrides in system.run.prepare",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prepare-env-"));
      const toolPath = path.join(tempDir, "tool");
      fs.writeFileSync(toolPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(toolPath, 0o755);

      try {
        await withEnvAsync(
          { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
          async () => {
            const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
            const skillBins: SkillBinsProvider = { current: async () => [] };

            await handleInvoke(
              {
                id: "invoke-prepare-env",
                nodeId: "node-1",
                command: "system.run.prepare",
                paramsJSON: JSON.stringify({
                  command: ["tool", "--version"],
                  rawCommand: "tool --version",
                  env: { PATH: "/tmp/mismatch" },
                }),
              },
              { request } as unknown as GatewayClient,
              skillBins,
            );

            expect(request).toHaveBeenCalledWith(
              "node.invoke.result",
              expect.objectContaining({
                id: "invoke-prepare-env",
                nodeId: "node-1",
                ok: false,
                error: expect.objectContaining({
                  code: "INVALID_REQUEST",
                  message: expect.stringContaining("blocked override keys: PATH"),
                }),
              }),
            );
          },
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("wraps malformed paramsJSON for built-in commands", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: "{not json",
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "invoke-1",
        nodeId: "node-1",
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("paramsJSON malformed JSON"),
        }),
      }),
    );
  });

  it("includes effective exec policy in system.run.prepare responses", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run.prepare",
        paramsJSON: JSON.stringify({
          command: ["echo", "ok"],
          rawCommand: "echo ok",
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        ok: true,
        payloadJSON: expect.any(String),
      }),
    );
    const result = request.mock.calls.find(([method]) => method === "node.invoke.result")?.[1] as {
      payloadJSON?: string;
    };
    const payload = JSON.parse(result.payloadJSON ?? "{}") as {
      execPolicy?: { security?: string; ask?: string };
    };
    expect(payload.execPolicy).toEqual({ security: "allowlist", ask: "on-miss" });
  });
});

describe("clarifyNodeExecCwdSpawnError", () => {
  const enoent = (msg: string) =>
    Object.assign(new Error(msg), { code: "ENOENT" }) as NodeJS.ErrnoException;

  it("blames the missing working directory instead of the shell on chdir ENOENT", () => {
    const cwd = path.join(os.tmpdir(), `node-exec-missing-${process.pid}-${Date.now()}`);
    const clarified = clarifyNodeExecCwdSpawnError(enoent("spawn /bin/sh ENOENT"), cwd);
    expect(clarified).toBe(
      `node exec working directory does not exist on the node host: ${cwd} (os reported: spawn /bin/sh ENOENT)`,
    );
  });

  it("flags a cwd that exists but is not a directory", () => {
    const file = path.join(os.tmpdir(), `node-exec-file-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(file, "x");
    try {
      const err = Object.assign(new Error("spawn ENOTDIR"), {
        code: "ENOTDIR",
      }) as NodeJS.ErrnoException;
      expect(clarifyNodeExecCwdSpawnError(err, file)).toBe(
        `node exec working directory is not a directory on the node host: ${file} (os reported: spawn ENOTDIR)`,
      );
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("preserves the original message when the cwd exists (genuine missing executable)", () => {
    const message = "spawn /usr/bin/does-not-exist ENOENT";
    expect(clarifyNodeExecCwdSpawnError(enoent(message), os.tmpdir())).toBe(message);
  });

  it("preserves the original message when no cwd was supplied", () => {
    const message = "spawn /bin/sh ENOENT";
    expect(clarifyNodeExecCwdSpawnError(enoent(message), undefined)).toBe(message);
  });

  it("ignores errors unrelated to the working directory", () => {
    const err = Object.assign(new Error("spawn EACCES"), {
      code: "EACCES",
    }) as NodeJS.ErrnoException;
    const cwd = path.join(os.tmpdir(), `node-exec-eacces-${process.pid}-${Date.now()}`);
    expect(clarifyNodeExecCwdSpawnError(err, cwd)).toBe("spawn EACCES");
  });
});

describe("runCommand working directory failures", () => {
  it.runIf(process.platform !== "win32")(
    "fails closed with a clarified message when the cwd does not exist (async spawn error)",
    async () => {
      const cwd = path.join(os.tmpdir(), `node-exec-run-missing-${process.pid}-${Date.now()}`);
      const result = await runCommand(["/bin/sh", "-lc", "echo hi"], cwd, undefined, undefined);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `node exec working directory does not exist on the node host: ${cwd}`,
      );
      expect(result.error).toContain("ENOENT");
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed without crashing when the cwd is a file (synchronous spawn throw)",
    async () => {
      const file = path.join(os.tmpdir(), `node-exec-run-file-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(file, "x");
      try {
        const result = await runCommand(["/bin/sh", "-lc", "echo hi"], file, undefined, undefined);
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          `node exec working directory is not a directory on the node host: ${file}`,
        );
        expect(result.error).toContain("ENOTDIR");
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  );
});
