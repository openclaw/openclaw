import fs from "node:fs";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import { stripAnsi } from "../terminal/ansi.js";
import { registerExecPolicyCli } from "./exec-policy-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  let configState: OpenClawConfig = {
    tools: {
      exec: {
        host: "auto",
        security: "allowlist",
        ask: "on-miss",
      },
    },
  };
  let approvalsState: ExecApprovalsFile = {
    version: 1,
    defaults: {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
    },
    agents: {},
  };
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    getConfig: () => configState,
    setConfig: (next: OpenClawConfig) => {
      configState = next;
    },
    getApprovals: () => approvalsState,
    setApprovals: (next: ExecApprovalsFile) => {
      approvalsState = next;
    },
    defaultRuntime,
    runtimeErrors,
    mutateConfigFile: vi.fn(async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
      const draft = structuredClone(configState);
      mutate(draft);
      configState = draft;
      return {
        path: "/tmp/openclaw.json",
        previousHash: "hash-1",
        snapshot: { path: "/tmp/openclaw.json" },
        nextConfig: draft,
        result: undefined,
      };
    }),
    replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
      configState = structuredClone(nextConfig);
      return {
        path: "/tmp/openclaw.json",
        previousHash: "hash-1",
        snapshot: { path: "/tmp/openclaw.json" },
        nextConfig,
      };
    }),
    readConfigFileSnapshot: vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      config: configState,
    })),
    readExecApprovalsSnapshot: vi.fn(() => ({
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: "{}",
      hash: "approvals-hash",
      file: approvalsState,
    })),
    saveExecApprovals: vi.fn((file: ExecApprovalsFile) => {
      approvalsState = file;
    }),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: mocks.readExecApprovalsSnapshot,
    saveExecApprovals: mocks.saveExecApprovals,
  };
});

describe("exec-policy CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecPolicyCli(program);
    return program;
  };

  const runExecPolicyCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "auto",
          security: "allowlist",
          ask: "on-miss",
        },
      },
    });
    mocks.setApprovals({
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
      },
      agents: {},
    });
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.mutateConfigFile.mockClear();
    mocks.replaceConfigFile.mockClear();
    mocks.readConfigFileSnapshot.mockClear();
    mocks.readExecApprovalsSnapshot.mockClear();
    mocks.saveExecApprovals.mockClear();
  });

  it("shows the local merged exec policy as json", async () => {
    await runExecPolicyCommand(["exec-policy", "show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        approvalsPath: "/tmp/exec-approvals.json",
        effectivePolicy: expect.objectContaining({
          scopes: [
            expect.objectContaining({
              scopeLabel: "tools.exec",
              security: expect.objectContaining({
                requested: "allowlist",
                host: "allowlist",
                effective: "allowlist",
              }),
              ask: expect.objectContaining({
                requested: "on-miss",
                host: "on-miss",
                effective: "on-miss",
              }),
            }),
          ],
        }),
      }),
      0,
    );
  });

  it("applies the yolo preset to both config and approvals", async () => {
    await runExecPolicyCommand(["exec-policy", "preset", "yolo", "--json"]);

    expect(mocks.getConfig().tools?.exec).toEqual({
      host: "gateway",
      security: "full",
      ask: "off",
    });
    expect(mocks.getApprovals().defaults).toEqual({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
    expect(mocks.saveExecApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
  });

  it("sets explicit values without requiring a preset", async () => {
    await runExecPolicyCommand([
      "exec-policy",
      "set",
      "--host",
      "gateway",
      "--security",
      "full",
      "--ask",
      "off",
      "--ask-fallback",
      "allowlist",
      "--json",
    ]);

    expect(mocks.getConfig().tools?.exec).toEqual({
      host: "gateway",
      security: "full",
      ask: "off",
    });
    expect(mocks.getApprovals().defaults).toEqual({
      security: "full",
      ask: "off",
      askFallback: "allowlist",
    });
  });

  it("sanitizes terminal control content before rendering the text table", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "auto",
          security: "allowlist\u001B[31m" as unknown as "allowlist",
          ask: "on-miss",
        },
      },
    });
    mocks.readConfigFileSnapshot.mockImplementationOnce(async () => ({
      path: "/tmp/openclaw.json\u001B[2J\nforged",
      config: mocks.getConfig(),
    }));
    mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => ({
      path: "/tmp/exec-approvals.json\u0007\nforged",
      exists: true,
      raw: "{}",
      hash: "approvals-hash",
      file: {
        version: 1,
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
        },
        agents: {
          "scope\u200Bname": {
            security: "allowlist",
            ask: "on-miss",
            askFallback: "deny",
          },
        },
      },
    }));

    await runExecPolicyCommand(["exec-policy", "show"]);

    const output = stripAnsi(
      mocks.defaultRuntime.log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"),
    );
    expect(output).toContain("/tmp/openclaw.json");
    expect(output).toContain("/tmp/exec-approvals.json");
    expect(output).toContain("scope\\u{200B}name");
    expect(output).toContain("host=auto");
    expect(output).toContain("tools.exec.");
    expect(output).toContain("host)");
    expect(output).toContain("\\nforged");
    expect(output).not.toContain("/tmp/openclaw.json\nforged");
    expect(output).not.toContain("\u001B[2J");
    expect(output).not.toContain("\u0007");
  });

  it("reports invalid input once and exits once", async () => {
    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "nope"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeErrors).toEqual(["Invalid exec security: nope"]);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it("rejects host=node for the local-only sync path", async () => {
    await expect(runExecPolicyCommand(["exec-policy", "set", "--host", "node"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.runtimeErrors).toEqual([
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    ]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("rejects sync when the resulting requested host remains node", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "node",
          security: "allowlist",
          ask: "on-miss",
        },
      },
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runtimeErrors).toEqual([
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    ]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("rolls back approvals if the config write fails after approvals save", async () => {
    const writeFileSyncSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const originalApprovals = structuredClone(mocks.getApprovals());
    const originalRaw = JSON.stringify(originalApprovals, null, 2);
    const originalSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: originalRaw,
      hash: "approvals-hash",
      file: originalApprovals,
    } as ExecApprovalsSnapshot as ReturnType<typeof mocks.readExecApprovalsSnapshot>;
    mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => originalSnapshot);
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.saveExecApprovals).toHaveBeenCalledTimes(1);
    expect(writeFileSyncSpy).toHaveBeenCalledWith("/tmp/exec-approvals.json", originalRaw, "utf8");
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });

  it("removes a newly-written approvals file when config replacement fails and the original file was missing", async () => {
    const rmSyncSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    const missingSnapshot = {
      path: "/tmp/missing-exec-approvals.json",
      exists: false,
      raw: null,
      hash: "approvals-hash",
      file: { version: 1, agents: {} },
    } as ExecApprovalsSnapshot as ReturnType<typeof mocks.readExecApprovalsSnapshot>;
    mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => missingSnapshot);
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(rmSyncSpy).toHaveBeenCalledWith("/tmp/missing-exec-approvals.json", { force: true });
  });
});
