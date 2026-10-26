// Suites load this fixture before the CLI so runtime dependencies see the mocks.
import { Command } from "commander";
import { vi } from "vitest";
import type { ClientSocketRecord } from "../infra/client-credential-store.js";
import { applyExecApprovalsUpdate } from "../infra/exec-approvals-mutation.kernel.js";
import type { ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const runtime = createCliRuntimeMock(vi);
  return {
    callGatewayFromCli: vi.fn(
      async (
        method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<unknown> => {
        if (method === "config.get") {
          return { config: { tools: { exec: { security: "full", ask: "off" } } } };
        }
        if (!method.endsWith(".get")) {
          return { method, params };
        }
        return {
          path: "/tmp/exec-approvals.json",
          exists: true,
          hash: "hash-1",
          file: { version: 1, agents: {} },
          ...(method === "exec.approvals.node.get"
            ? {
                resolvedDefaults: {
                  security: "allowlist",
                  ask: "on-miss",
                  askFallback: "deny",
                  autoAllowSkills: false,
                },
              }
            : {}),
        };
      },
    ),
    ...runtime,
    readBestEffortConfig: vi.fn(async () => ({})),
  };
});

export const {
  callGatewayFromCli,
  defaultRuntime,
  readBestEffortConfig,
  runtimeErrors,
  runtimeLogs,
} = mocks;
export const localSnapshot: ExecApprovalsSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} },
};
let localSocket: ClientSocketRecord | null = null;

export function setLocalSocket(path: string, token: string): void {
  localSocket = {
    socket_key: "current",
    socket_path: path,
    socket_token: token,
    updated_at_ms: 1,
  };
}

function resetLocalSnapshot() {
  localSocket = null;
  localSnapshot.exists = true;
  localSnapshot.raw = "{}";
  localSnapshot.hash = "hash-local";
  localSnapshot.file = { version: 1, agents: {} };
}

// mock-isolation: Approval CLI fixtures supply Gateway replies without opening a real connection.
vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: ({ runLocal }: { runLocal: (scope: unknown) => unknown }) =>
    runLocal({ env: process.env, assertCurrent() {} }),
}));

vi.mock("./nodes-cli/rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nodes-cli/rpc.js")>()),
  resolveCliNodeId: vi.fn(async () => "node-1"),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshotAsync: async () => localSnapshot,
    updateExecApprovals: vi.fn(
      async ({ baseHash, update }: Parameters<typeof actual.updateExecApprovals>[0]) => {
        if (baseHash !== undefined && baseHash !== localSnapshot.hash) {
          return null;
        }
        const next = applyExecApprovalsUpdate(structuredClone(localSnapshot.file), update);
        if (next !== null) {
          localSnapshot.file = next;
          localSnapshot.raw = JSON.stringify(next);
          localSnapshot.hash = "hash-local-written";
        }
        const snapshot = structuredClone(localSnapshot);
        if (update.kind === "replace" && update.preserveSocket) {
          setLocalSocket(
            update.file.socket?.path?.trim() ||
              localSocket?.socket_path ||
              "/tmp/local-exec-approvals.sock",
            update.file.socket?.token?.trim() || localSocket?.socket_token || "fixture-token",
          );
          snapshot.file.socket = {
            ...snapshot.file.socket,
            path: localSocket?.socket_path ?? undefined,
            token: localSocket?.socket_token ?? undefined,
          };
        }
        return snapshot;
      },
    ),
  };
});

// mock-isolation: CLI fixtures use synthetic socket data without admitting the real credential owner.
vi.mock("../infra/exec-approvals-socket.js", () => ({
  readExecApprovalsSocket: async () => structuredClone(localSocket),
}));

export const loggedOutput = (): string => runtimeLogs.join("\n");

export function resetExecApprovalsCliMocks(): void {
  resetLocalSnapshot();
  runtimeLogs.length = 0;
  runtimeErrors.length = 0;
  for (const mock of [callGatewayFromCli, readBestEffortConfig, ...Object.values(defaultRuntime)]) {
    mock.mockClear();
  }
}

export async function runApprovalsCommand(args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerExecApprovalsCli(program);
  await program.parseAsync(args, { from: "user" });
}
